import { memo, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Text, View, useWindowDimensions, type TextInput } from "react-native";
import CloudOff from "lucide-react-native/icons/cloud-off";
import { useRouter } from "expo-router";

import { isValidNewPassword, useSession } from "../../auth/session";
import { isEmail } from "../../domain/names";
import { tr } from "../../i18n/tr";
import { heldInvite } from "../../sync/sharing";
import { Body, Button, Card, CODE_FIELD, CODE_LENGTH, EMAIL_FIELD, Notice, Screen, TextField } from "../../ui/components";
import { interactionSurface } from "../../ui/interaction";
import { Press } from "../../ui/press";
import { LegalConsentControl, LegalNoticeSheet } from "../../ui/legal-notice";
import { BrandMark } from "../../ui/brand";
import { shouldSplitAuthHero } from "../../ui/responsive";
import { authHero, contentWidth, controlSize, font, radius, spacing, type, useTheme } from "../../ui/theme";

/** `confirm` and `reset` take the code the e-mail of `signUp` and `forgot` carries. */
type Mode = "signIn" | "signUp" | "forgot" | "confirm" | "reset";

/** What each mode says, which fields it asks for, what its password must be, and where its second link goes. */
const MODE: Record<
  Mode,
  { heading: string; subtitle: (email: string) => string; action: string; other: string; otherMode: Mode; email: boolean; code: boolean; password: "current" | "new" | null }
> = {
  signIn: { heading: tr.auth.signInTitle, subtitle: () => tr.auth.signInSubtitle, action: tr.auth.signIn, other: tr.auth.toSignUp, otherMode: "signUp", email: true, code: false, password: "current" },
  signUp: { heading: tr.auth.signUpTitle, subtitle: () => tr.auth.signUpSubtitle, action: tr.auth.signUpTitle, other: tr.auth.toSignIn, otherMode: "signIn", email: true, code: false, password: "new" },
  forgot: { heading: tr.auth.forgotTitle, subtitle: () => tr.auth.forgotSubtitle, action: tr.auth.sendResetCode, other: tr.auth.backToSignIn, otherMode: "signIn", email: true, code: false, password: null },
  confirm: { heading: tr.auth.confirmTitle, subtitle: tr.auth.confirmSubtitle, action: tr.auth.confirmAction, other: tr.auth.backToSignIn, otherMode: "signIn", email: false, code: true, password: null },
  reset: { heading: tr.auth.resetTitle, subtitle: tr.auth.resetSubtitle, action: tr.auth.resetSave, other: tr.auth.backToSignIn, otherMode: "signIn", email: false, code: true, password: "new" },
};

const passwordReady = (kind: "current" | "new" | null, password: string) => (kind === "new" ? isValidNewPassword(password) : kind === null || password !== "");
const codeReady = (code: string) => new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code);

/** Inline links rather than stacked ghost buttons, which pushed the form past a phone's fold; each
 *  keeps the 44-point target. */
function AuthLink({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { palette } = useTheme();
  return (
    <Press
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => ({
        minHeight: controlSize.minimumTarget,
        justifyContent: "center",
        paddingHorizontal: spacing.xs,
        borderRadius: radius.sm,
        ...interactionSurface(palette, state, { enabled: !disabled }),
      })}
    >
      <Text style={[type.small, { color: disabled ? palette.textSecondary : palette.accentText, fontFamily: font.semibold }]}>{label}</Text>
    </Press>
  );
}

type Outcome = { tone: "error" | "success"; text: string };

/** Under a failure, which may be ours: the report needs no account. */
function ReportProblem({ outcome, email }: { outcome: Outcome | null; email: string }) {
  const router = useRouter();
  if (outcome?.tone !== "error") return null;
  return (
    <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
      <Button label={tr.auth.reportProblem} variant="ghost" size="sm" onPress={() => router.push({ pathname: "/feedback", params: { email: email.trim() } })} />
    </View>
  );
}

/** What the mode's request answered, and the mode it leads to; no outcome and no mode is a session, which the layout's guard takes from here. */
async function attempt(mode: Mode, email: string, password: string, code: string): Promise<{ outcome: Outcome | null; next?: Mode }> {
  const { signIn, signUp, requestPasswordReset, confirmSignUp, resetPassword, resendSignUpCode } = useSession.getState();
  const failed = (text: string | null) => ({ outcome: text ? { tone: "error" as const, text } : null });
  if (mode === "signIn") {
    const error = await signIn(email, password);
    if (error !== tr.auth.errEmailNotConfirmed) return failed(error);
    // An account never confirmed is one code away, not a dead end. A resend
    // refused for coming too soon leaves the code already mailed to type.
    const resent = await resendSignUpCode(email);
    return !resent || resent === tr.auth.errRateLimit ? { outcome: null, next: "confirm" } : failed(resent);
  }
  if (mode === "forgot") {
    const error = await requestPasswordReset(email);
    return error ? failed(error) : { outcome: null, next: "reset" };
  }
  if (mode === "confirm") return failed(await confirmSignUp(email, code));
  if (mode === "reset") {
    const error = await resetPassword(email, code, password);
    return failed(error ?? (await signIn(email, password)));
  }
  const result = await signUp(email, password);
  if (result.status === "error") return failed(result.message);
  return result.status === "confirmation-required" ? { outcome: null, next: "confirm" } : { outcome: null };
}

/** Greeting beside the form when there is room for both, above it when not. */
function AuthSplit({ wide, children }: { wide: boolean; children: ReactNode }) {
  return (
    <View style={{ flexDirection: wide ? "row" : "column", alignItems: "flex-start", gap: wide ? spacing.xxl : spacing.lg, paddingVertical: wide ? spacing.xl : spacing.lg }}>
      {children}
    </View>
  );
}

function AuthColumn({ wide, share, children }: { wide: boolean; share: number; children: ReactNode }) {
  return <View style={{ flex: wide ? share : undefined, alignSelf: wide ? "flex-start" : "stretch", minWidth: 0 }}>{children}</View>;
}

/** The greeting beside the form, or above it on a phone; memoised, since every keystroke re-renders its parent. */
const AuthGreeting = memo(function AuthGreeting({ wide }: { wide: boolean }) {
  const { palette } = useTheme();
  return (
    <AuthColumn wide={wide} share={1.08}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.sm }}>
        <BrandMark height={wide ? authHero.markWide : authHero.mark} />
        <Text
          accessibilityRole="header"
          aria-level={1}
          style={[
            type.display,
            {
              flex: 1,
              minWidth: 0,
              color: palette.textStrong,
              lineHeight: wide ? authHero.titleLineWide : authHero.titleLine,
              fontSize: wide ? type.display.fontSize : Math.round(type.sectionTitle.fontSize * authHero.titleScale),
            },
          ]}
        >
          {tr.auth.welcomeTitle}
        </Text>
      </View>
      <Body muted style={{ marginBottom: spacing.lg, maxWidth: authHero.bodyMaxWidth, lineHeight: authHero.bodyLine }}>{tr.auth.welcomeBody}</Body>
      {/* Decoration, and the first thing to go when the form grows: a phone
          has to reach the button without scrolling. */}
    </AuthColumn>
  );
});

function OfflineNote() {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, marginTop: spacing.sm }}>
      <CloudOff accessible={false} size={authHero.noteIcon} color={palette.textSecondary} />
      <Text style={[type.small, { color: palette.textSecondary, textAlign: "center", flexShrink: 1 }]}>{tr.auth.offlineNote}</Text>
    </View>
  );
}

/**
 * A web invitation waits for the sign-in. Saying so keeps the person from
 * going to the app for it, which would ask for the link again (Gital's).
 */
function InviteWaiting() {
  const [invited, setInvited] = useState(false);
  useEffect(() => void heldInvite().then((token) => setInvited(token != null)), []);
  return invited ? <Notice tone="success" text={tr.sharing.inviteWaiting} /> : null;
}

/** The address, which is the last field only when a reset code is all that is asked for. */
function EmailField({ value, onChangeText, last, onSubmit, onNext }: { value: string; onChangeText: (value: string) => void; last: boolean; onSubmit: () => void; onNext: () => void }) {
  return (
    <TextField
      label={tr.auth.email}
      value={value}
      onChangeText={onChangeText}
      {...EMAIL_FIELD}
      returnKeyType={last ? "send" : "next"}
      onSubmitEditing={last ? onSubmit : onNext}
      // Waits for a plausible attempt rather than the first letter.
      error={value.trim().length > 3 && !isEmail(value) ? tr.auth.emailInvalid : null}
      style={{ marginBottom: spacing.md }}
    />
  );
}

/** The e-mail's code: offered above the keyboard where the platform reads it, and sent as soon as it is whole. */
function CodeField({ value, onChangeText, onSubmit }: { value: string; onChangeText: (value: string) => void; onSubmit: () => void }) {
  return (
    <TextField
      label={tr.auth.code}
      value={value}
      onChangeText={(typed) => onChangeText(typed.replace(/\D/g, ""))}
      {...CODE_FIELD}
      autoFocus
      returnKeyType="go"
      onSubmitEditing={onSubmit}
      style={{ marginBottom: spacing.md }}
    />
  );
}

/** Sign-up's password is a new one, checked as it is typed; sign-in's is only the one already set. */
function PasswordField({ ref, creating, value, onChangeText, onSubmit }: { ref: Ref<TextInput>; creating: boolean; value: string; onChangeText: (value: string) => void; onSubmit: () => void }) {
  return (
    <TextField
      ref={ref}
      label={tr.auth.password}
      value={value}
      onChangeText={onChangeText}
      secure
      autoCapitalize="none"
      autoComplete={creating ? "new-password" : "current-password"}
      textContentType={creating ? "newPassword" : "password"}
      returnKeyType="go"
      onSubmitEditing={onSubmit}
      error={creating && value !== "" && !isValidNewPassword(value) ? tr.auth.passwordHint : null}
      style={{ marginBottom: spacing.md }}
    />
  );
}

function ModeLinks({ mode, busy, onSwitch, onResend }: { mode: Mode; busy: boolean; onSwitch: (next: Mode) => void; onResend: () => void }) {
  const { other, otherMode } = MODE[mode];
  return (
    <View style={{ alignItems: "center", marginTop: spacing.sm }}>
      {MODE[mode].code ? <AuthLink label={tr.auth.resendCode} onPress={onResend} disabled={busy} /> : null}
      {/* The way to an account first: someone new looks for it, someone locked out reads on. */}
      <AuthLink label={other} onPress={() => onSwitch(otherMode)} disabled={busy} />
      {mode === "signIn" ? <AuthLink label={tr.auth.forgotPassword} onPress={() => onSwitch("forgot")} disabled={busy} /> : null}
    </View>
  );
}

/** Sign-in (SPEC 2.1): one card in five modes on one skeleton, the notice opened over the form.
 *  Success needs no navigation: the root layout's guard swaps this screen out. */
export default function SignInScreen() {
  const { palette } = useTheme();
  const { width } = useWindowDimensions();
  const wide = shouldSplitAuthHero(Math.min(width - 2 * spacing.xxl, contentWidth.form));
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [consented, setConsented] = useState(false);
  /** Only after a refused press: the form does not scold while it is being filled. */
  const [consentRefused, setConsentRefused] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  const text = MODE[mode];
  // Consent is kept out of `formReady`, so the button stays pressable while it
  // is all that is missing, and pressing it says so; a greyed button never does.
  // A code is read as typed, since a whole one is sent before its state lands.
  const readyWith = (typed: string) => isEmail(email) && (!text.code || codeReady(typed)) && passwordReady(text.password, password) && !busy;
  const formReady = readyWith(code);

  const submit = async (typedCode = code) => {
    if (!readyWith(typedCode) || (mode === "signUp" && !consented)) return;
    setBusy(true);
    setOutcome(null);
    const answered = await attempt(mode, email.trim(), password, typedCode).catch((): { outcome: Outcome; next?: Mode } => ({ outcome: { tone: "error", text: tr.auth.errGeneric } }));
    setBusy(false);
    setOutcome(answered.outcome);
    if (answered.next) {
      setMode(answered.next);
      setCode("");
      // The reset step asks for a new password; the one typed to sign in is not it.
      if (answered.next === "reset") setPassword("");
    }
  };
  /** A whole code goes at once where it is all that is asked: the step after autofill is the app's. */
  const typeCode = (typed: string) => {
    setCode(typed);
    if (outcome?.tone === "error") setOutcome(null);
    if (mode === "confirm" && codeReady(typed)) void submit(typed);
  };
  const resend = async () => {
    setBusy(true);
    const { resendSignUpCode, requestPasswordReset } = useSession.getState();
    const error = await (mode === "confirm" ? resendSignUpCode : requestPasswordReset)(email.trim()).catch(() => tr.auth.errGeneric);
    setBusy(false);
    setCode("");
    setOutcome(error ? { tone: "error", text: error } : { tone: "success", text: tr.auth.codeResent });
  };
  const press = () => {
    if (mode === "signUp" && !consented) setConsentRefused(true);
    else void submit();
  };
  /** Consent belongs to the attempt that was made, not to the session. */
  const switchTo = (next: Mode) => {
    setMode(next);
    setOutcome(null);
    setPassword("");
    setCode("");
    setConsented(false);
    setConsentRefused(false);
  };
  const accept = () => {
    setConsented(true);
    setConsentRefused(false);
    setNoticeOpen(false);
  };
  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    if (outcome?.tone === "error") setOutcome(null);
  };

  return (
    <Screen width="form">
      {/* Top-aligned, not centred: centring re-laid the column on every change
          in the card's height, and the mark drifted with each mode. */}
      <AuthSplit wide={wide}>
        <AuthGreeting wide={wide} />
        {/* One skeleton for every mode, so switching does not redraw a card of each size. */}
        <AuthColumn wide={wide} share={0.92}>
          <InviteWaiting />
          <Card>
            <Text accessibilityRole="header" aria-level={2} style={[type.heading, { color: palette.text, marginBottom: spacing.xs }]}>{text.heading}</Text>
            <Body muted style={{ marginBottom: spacing.lg }}>{text.subtitle(email.trim())}</Body>
            {text.email ? (
              <EmailField value={email} onChangeText={edit(setEmail)} last={text.password === null} onSubmit={press} onNext={() => passwordRef.current?.focus()} />
            ) : null}
            {text.code ? <CodeField value={code} onChangeText={typeCode} onSubmit={press} /> : null}
            {text.password ? (
              <PasswordField ref={passwordRef} creating={text.password === "new"} value={password} onChangeText={edit(setPassword)} onSubmit={press} />
            ) : null}
            {outcome ? <Notice {...outcome} /> : null}
            <ReportProblem outcome={outcome} email={email} />
            {/* Before the account exists, not after: creating one is when an
                address starts being held on servers abroad. */}
            {mode === "signUp" ? (
              <>
                <Body muted style={{ marginBottom: spacing.sm, fontSize: type.small.fontSize }}>{tr.legal.signUpNotice}</Body>
                <LegalConsentControl consented={consented} onOpen={() => setNoticeOpen(true)} invalid={consentRefused && !consented} />
              </>
            ) : null}
            <Button label={text.action} loading={busy} disabled={!formReady} onPress={press} />
            <ModeLinks mode={mode} busy={busy} onSwitch={switchTo} onResend={() => void resend()} />
            <OfflineNote />
          </Card>
        </AuthColumn>
      </AuthSplit>
      {noticeOpen ? (
        <LegalNoticeSheet
          onClose={() => setNoticeOpen(false)}
          // Only sign-up accepts; opened from anywhere else it is a document to read.
          onAccept={mode === "signUp" ? accept : undefined}
        />
      ) : null}
    </Screen>
  );
}
