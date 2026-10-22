/** Account security (SPEC 2.3): e-mail, password, a reset code to one's own address, the data reset
 *  and the two endings. A change asks for the current password in its own card, not after the fact;
 *  an e-mailed code is asked for in the card that sent it, not in a dialog over it. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Redirect, router } from "expo-router";
import Eraser from "lucide-react-native/icons/eraser";
import KeyRound from "lucide-react-native/icons/key-round";
import Mail from "lucide-react-native/icons/mail";
import RotateCcw from "lucide-react-native/icons/rotate-ccw";
import Snowflake from "lucide-react-native/icons/snowflake";
import Trash from "lucide-react-native/icons/trash";

import { deviceId } from "../auth/login-history";
import { isValidNewPassword, useSession, type EmailChangeCodes } from "../auth/session";
import { isEmail } from "../domain/names";
import { useSettings } from "../data/hooks";
import { lastLogin } from "../domain/logins";
import { tr } from "../i18n/tr";
import { kv } from "../services/kv";
import { isSupabaseConfigured } from "../sync/supabase";
import { Body, Button, Card, CODE_FIELD, CODE_LENGTH, Divider, EMAIL_FIELD, ListRow, PanelHeader, Screen, TextField } from "../ui/components";
import { appConfirm, appError, appPrompt } from "../ui/dialog";
import { useDirtyExitGuard } from "../ui/dirty-exit";
import { spacing, type, useTheme } from "../ui/theme";
import { showNotice } from "../ui/undo";

export default function AccountSecurityScreen() {
  // A device with no project has no account to secure.
  if (!isSupabaseConfigured) return <Redirect href="/settings" />;
  return <CloudAccountSecurity />;
}

function CloudAccountSecurity() {
  const { email, previousLoginAt, verifyPassword, changePassword, freezeAccount, deleteAccount } = useSession();
  const { palette } = useTheme();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [cardDrafts, setCardDrafts] = useState({ email: false, reset: false });
  const draftIn = (card: keyof typeof cardDrafts) => (dirty: boolean) => setCardDrafts((held) => (held[card] === dirty ? held : { ...held, [card]: dirty }));
  // A save clears its fields, so only a draft still typed asks before leaving.
  useDirtyExitGuard([currentPassword, newPassword].some(Boolean) || cardDrafts.email || cardDrafts.reset);
  const settings = useSettings();
  const [device, setDevice] = useState<string | null>(null);
  useEffect(() => void deviceId(kv).then(setDevice, () => {}), []);
  // Every device's own row, once synced; until then, this device's memory.
  const login = lastLogin(settings.data, device, previousLoginAt);
  const previous = login && tr.account.previousLogin(login.at, login.device, login.here);

  /** One change at a time, and a refusal said where it happened. The ref, not
   *  the state: an auto-submit and a tap in one frame both read the same render. */
  const running = useRef(false);
  const run: Run = (which, work) => async () => {
    if (running.current) return;
    running.current = true;
    setBusy(which);
    try {
      await work();
    } catch {
      await appError(tr.auth.errGeneric);
    }
    running.current = false;
    setBusy(null);
  };

  const passwordReady = currentPassword !== "" && isValidNewPassword(newPassword);
  const submitPassword = run("password", async () => {
    const refused = (await verifyPassword(currentPassword)) ?? (await changePassword(currentPassword, newPassword));
    if (refused) return void (await appError(refused));
    setCurrentPassword("");
    setNewPassword("");
    showNotice(tr.account.passwordChanged);
  });

  /** The last word before an ending: the password, checked before anything is touched. */
  const passwordFor = async (body: string, confirmLabel: string): Promise<boolean> => {
    const password = await appPrompt(tr.account.confirmPasswordTitle, body, { confirmLabel, kind: "password" });
    if (password == null) return false;
    const refused = await verifyPassword(password);
    if (refused) await appError(refused);
    return refused == null;
  };
  const freeze = run("freeze", async () => {
    if (!(await appConfirm(tr.account.freezeTitle, tr.account.freezeBody, tr.account.freezeConfirm))) return;
    if (!(await passwordFor(tr.account.freezePasswordBody, tr.account.freezeConfirm))) return;
    const refused = await freezeAccount();
    if (refused) await appError(refused);
  });
  const remove = run("delete", async () => {
    if (!(await appConfirm(tr.account.deleteTitle, tr.account.deleteBody, tr.account.deleteConfirm))) return;
    if (!(await passwordFor(tr.account.deletePasswordBody, tr.account.deleteConfirm))) return;
    const refused = await deleteAccount();
    if (refused) await appError(refused);
  });

  return (
    <Screen title={tr.account.security} back="/settings">
      {previous ? <Body muted style={{ marginBottom: spacing.md }}>{previous}</Body> : null}
      <EmailCard email={email} busy={busy} run={run} onDraft={draftIn("email")} />

      <Card>
        <PanelHeader icon={KeyRound} title={tr.account.changePassword} description={tr.account.changePasswordSectionHint} />
        <TextField
          label={tr.account.currentPassword}
          value={currentPassword}
          onChangeText={setCurrentPassword}
          secure
          autoComplete="current-password"
          textContentType="password"
          placeholder={tr.account.currentPasswordPlaceholder}
          style={{ marginBottom: spacing.md }}
        />
        <TextField
          label={tr.auth.newPassword}
          value={newPassword}
          onChangeText={setNewPassword}
          secure
          autoComplete="new-password"
          textContentType="newPassword"
          placeholder={tr.account.newPasswordPlaceholder}
          error={newPassword !== "" && !isValidNewPassword(newPassword) ? tr.auth.passwordHint : null}
          style={{ marginBottom: spacing.md }}
        />
        <Button label={tr.account.changePassword} loading={busy === "password"} disabled={!passwordReady || busy != null} onPress={() => void submitPassword()} />
      </Card>

      <ResetCard email={email} busy={busy} run={run} onDraft={draftIn("reset")} />

      {/* Erasing records sits above the two endings: the same kind of decision
          at a smaller scale, and the one reached for first when what is wanted
          is a clean slate rather than no account. */}
      <Card rows>
        <ListRow icon={Eraser} title={tr.dataReset.title} subtitle={tr.dataReset.entryDescription} chevron onPress={() => router.push("/data-reset")} />
      </Card>

      <Card rows>
        <ListRow
          icon={Snowflake}
          title={tr.account.freeze}
          subtitle={tr.account.freezeSignatureDescription}
          chevron
          onPress={busy ? undefined : () => void freeze()}
        />
        <Divider flush />
        <ListRow
          icon={Trash}
          iconColor={palette.error}
          title={tr.account.delete}
          subtitle={tr.account.deleteSignatureDescription}
          chevron
          onPress={busy ? undefined : () => void remove()}
        />
      </Card>
    </Screen>
  );
}

type Busy = "email" | "emailCodes" | "password" | "reset" | "resetSave" | "freeze" | "delete" | null;
/** One change at a time across the screen's cards. */
type Run = (which: NonNullable<Busy>, work: () => Promise<void>) => () => Promise<void>;
type CardProps = { email: string | null; busy: Busy; run: Run; onDraft: (dirty: boolean) => void };

/** The new address and the password, then the code each address was sent. */
function EmailCard({ email, busy, run, onDraft }: CardProps) {
  const { verifyPassword, changeEmail, confirmEmailChange } = useSession();
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  /** The address the change codes went to; the card then asks for them. */
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [emailCodes, setEmailCodes] = useState<EmailChangeCodes>(NO_CODES);
  const [acceptedCodes, setAcceptedCodes] = useState<Record<keyof EmailChangeCodes, boolean>>(NONE_ACCEPTED);
  const dirty = [newEmail, emailPassword, emailCodes.current, emailCodes.next].some(Boolean);
  useEffect(() => onDraft(dirty), [dirty, onDraft]);

  const emailReady = isEmail(newEmail) && emailPassword !== "";
  const submitEmail = run("email", async () => {
    // Auth sends no code for the address the account already has.
    if (newEmail.trim().toLowerCase() === email?.toLowerCase()) return void (await appError(tr.account.sameEmail));
    const refused = (await verifyPassword(emailPassword)) ?? (await changeEmail(newEmail));
    if (refused) return void (await appError(refused));
    setPendingEmail(newEmail.trim());
    setEmailCodes(NO_CODES);
    setAcceptedCodes(NONE_ACCEPTED);
    setNewEmail("");
    setEmailPassword("");
  });
  /** New codes replace the old ones, so the ones already typed and taken start over. */
  const resendEmailCodes = run("email", async () => {
    if (!pendingEmail) return;
    const refused = await changeEmail(pendingEmail);
    if (refused) return void (await appError(refused));
    setEmailCodes(NO_CODES);
    setAcceptedCodes(NONE_ACCEPTED);
    showNotice(tr.account.codesResent);
  });
  const codesReady = (codes: EmailChangeCodes) => (["current", "next"] as const).every((side) => acceptedCodes[side] || codeComplete(codes[side]));
  const confirmCodes = (codes: EmailChangeCodes) =>
    run("emailCodes", async () => {
      if (!pendingEmail || !codesReady(codes)) return;
      const answer = await confirmEmailChange(pendingEmail, codes);
      setAcceptedCodes(answer.accepted);
      if (answer.error) return void (await appError(answer.error));
      setPendingEmail(null);
      setEmailCodes(NO_CODES);
      showNotice(tr.account.emailChanged(pendingEmail));
    })();
  /** The last digit typed sends both codes, as the sign-up code does. */
  const typeEmailCode = (side: keyof EmailChangeCodes) => (typed: string) => {
    const codes = { ...emailCodes, [side]: typed.replace(/\D/g, "") };
    setEmailCodes(codes);
    if (codeComplete(codes[side]) && !busy && codesReady(codes)) void confirmCodes(codes);
  };
  const cancelEmailChange = () => {
    setPendingEmail(null);
    setEmailCodes(NO_CODES);
    setAcceptedCodes(NONE_ACCEPTED);
  };


  return (
      <Card>
        <PanelHeader
          icon={Mail}
          title={tr.account.changeEmail}
          description={pendingEmail && email ? tr.account.emailChangeSent(email, pendingEmail) : tr.account.changeEmailSectionHint}
        />
        {pendingEmail && email ? (
          <>
            {([["current", email], ["next", pendingEmail]] as const).map(([side, address], index) =>
              acceptedCodes[side] ? (
                <Body key={side} muted style={{ marginBottom: spacing.md }}>{tr.account.emailCodeAccepted(address)}</Body>
              ) : (
                <TextField
                  key={side}
                  label={tr.account.emailCodeFor(address)}
                  value={emailCodes[side]}
                  onChangeText={typeEmailCode(side)}
                  {...CODE_FIELD}
                  autoFocus={index === 0}
                  style={{ marginBottom: spacing.md }}
                />
              ),
            )}
            <Button
              label={tr.account.confirmEmailChange}
              loading={busy === "emailCodes"}
              disabled={!codesReady(emailCodes) || busy != null}
              onPress={() => void confirmCodes(emailCodes)}
            />
            <CardLinks>
              <Button label={tr.account.resendCodes} variant="ghost" loading={busy === "email"} disabled={busy != null} onPress={() => void resendEmailCodes()} />
              <Button label={tr.common.cancel} variant="ghost" disabled={busy != null} onPress={cancelEmailChange} />
            </CardLinks>
          </>
        ) : (
          <>
            {email ? <Body muted style={{ marginBottom: spacing.md }}>{tr.account.currentEmail(email)}</Body> : null}
            <TextField
              label={tr.account.newEmail}
              value={newEmail}
              onChangeText={setNewEmail}
              {...EMAIL_FIELD}
              style={{ marginBottom: spacing.md }}
            />
            <TextField
              label={tr.auth.password}
              value={emailPassword}
              onChangeText={setEmailPassword}
              secure
              autoComplete="current-password"
              textContentType="password"
              placeholder={tr.account.currentPasswordPlaceholder}
              style={{ marginBottom: spacing.md }}
            />
            <Button label={tr.account.changeEmail} loading={busy === "email"} disabled={!emailReady || busy != null} onPress={() => void submitEmail()} />
            <Body muted style={{ fontSize: type.small.fontSize, marginTop: spacing.sm }}>{tr.account.emailChangeHint}</Body>
          </>
        )}
      </Card>
  );
}

/** A code to the account's own address, then the code and a new password in the same card. */
function ResetCard({ email, busy, run, onDraft }: CardProps) {
  const { requestPasswordReset, resetPassword } = useSession();
  /** Set once the reset code is mailed: the card then asks for it and the new password. */
  const [resetSent, setResetSent] = useState(false);
  const [resetCode, setResetCode] = useState("");
  const [resetPasswordDraft, setResetPasswordDraft] = useState("");
  const dirty = [resetCode, resetPasswordDraft].some(Boolean);
  useEffect(() => onDraft(dirty), [dirty, onDraft]);

  const sendResetCode = run("reset", async () => {
    if (!email) return;
    const refused = await requestPasswordReset(email);
    if (refused) return void (await appError(refused));
    if (resetSent) showNotice(tr.auth.codeResent);
    setResetSent(true);
  });
  const resetReady = codeComplete(resetCode) && isValidNewPassword(resetPasswordDraft);
  const saveResetPassword = run("resetSave", async () => {
    if (!email || !resetReady) return;
    const failed = await resetPassword(email, resetCode, resetPasswordDraft);
    if (failed) return void (await appError(failed));
    cancelReset();
    showNotice(tr.account.passwordChanged);
  });
  const cancelReset = () => {
    setResetSent(false);
    setResetCode("");
    setResetPasswordDraft("");
  };


  return (
      <Card>
        <PanelHeader icon={RotateCcw} title={tr.auth.forgotPassword} description={resetSent && email ? tr.auth.resetSentToOwnAddress(email) : tr.account.resetCodeHint} />
        {resetSent ? (
          <>
            <TextField
              label={tr.auth.code}
              value={resetCode}
              onChangeText={(typed) => setResetCode(typed.replace(/\D/g, ""))}
              {...CODE_FIELD}
              autoFocus
              style={{ marginBottom: spacing.md }}
            />
            <TextField
              label={tr.auth.newPassword}
              value={resetPasswordDraft}
              onChangeText={setResetPasswordDraft}
              secure
              autoComplete="new-password"
              textContentType="newPassword"
              placeholder={tr.account.newPasswordPlaceholder}
              error={resetPasswordDraft !== "" && !isValidNewPassword(resetPasswordDraft) ? tr.auth.passwordHint : null}
              style={{ marginBottom: spacing.md }}
            />
            <Button label={tr.account.changePassword} loading={busy === "resetSave"} disabled={!resetReady || busy != null} onPress={() => void saveResetPassword()} />
            <CardLinks>
              <Button label={tr.auth.resendCode} variant="ghost" loading={busy === "reset"} disabled={busy != null} onPress={() => void sendResetCode()} />
              <Button label={tr.common.cancel} variant="ghost" disabled={busy != null} onPress={cancelReset} />
            </CardLinks>
          </>
        ) : (
          <Button label={tr.auth.sendResetCode} variant="secondary" loading={busy === "reset"} disabled={!email || busy != null} onPress={() => void sendResetCode()} />
        )}
      </Card>
  );
}

const NO_CODES: EmailChangeCodes = { current: "", next: "" };
const NONE_ACCEPTED = { current: false, next: false } as const;
const codeComplete = (code: string) => code.length === CODE_LENGTH;

/** A card's second actions, side by side under its first. */
function CardLinks({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.sm, marginTop: spacing.sm }}>{children}</View>;
}
