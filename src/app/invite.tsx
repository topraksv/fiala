/**
 * Joining a household by an invitation (`docs/TASKS.md` F2.2) in one press,
 * after the page says what and from whom; or answering an offer made in the
 * app. Gital's `src/app/invite.tsx`, with nothing brought along: the person's
 * own boxes stay theirs. The phone, in Expo Go, is not the link's target, so
 * it arrives here with the link pasted.
 */

import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import LogIn from "lucide-react-native/icons/log-in";

import { useHouseholds, useMemberName } from "../data/hooks";
import { chooseHousehold } from "../data/settings";
import { tr } from "../i18n/tr";
import { syncNow } from "../sync/engine";
import { acceptInvite, answerOffer, inviteFromPage, inviteTokenFrom, peekInvite, useOffers, type CabinetOffer, type InvitePeek } from "../sync/sharing";
import { Body, Button, Notice, Screen, TextField } from "../ui/components";
import { appError } from "../ui/dialog";
import { selectionTap } from "../ui/haptics";
import { navigateBack } from "../ui/navigation";
import { spacing } from "../ui/theme";
import { showNotice } from "../ui/undo";

type Peeked = Awaited<ReturnType<typeof peekInvite>>;
type Accept = (name: string) => Promise<{ cabinetId: string } | { refused: string }>;

export default function InviteScreen() {
  const params = useLocalSearchParams<{ token?: string; offer?: string }>();
  const [linked] = useState<string | null>(
    () => (params.token ? inviteTokenFrom(params.token) : null) ?? (Platform.OS === "web" && typeof location !== "undefined" ? inviteFromPage(location) : null),
  );
  // Held as the screen opened with it, since answering takes it out of the store.
  const [offer] = useState(() => (params.offer ? (useOffers.getState().received.find((held) => held.cabinetId === params.offer) ?? null) : undefined));
  const [joined, setJoined] = useState<string | null>(null);

  // Held in memory from here: in the address bar, a reload would send the
  // token to the host's logs, and history would keep it.
  useEffect(() => {
    if (Platform.OS === "web" && (location.search || location.hash)) history.replaceState(null, "", location.pathname);
  }, []);

  return (
    <Screen back="/households" title={tr.sharing.joinTitle} width="form">
      {joined ? <JoinedTo cabinetId={joined} /> : offer !== undefined ? <Offered offer={offer} onJoined={setJoined} /> : <Invitation linked={linked} onJoined={setJoined} />}
    </Screen>
  );
}

/** The household arrives with the join's sync, and Dolabım then shows it; until then the screen says it will. */
function JoinedTo({ cabinetId }: { cabinetId: string }) {
  const router = useRouter();
  const { households } = useHouseholds();
  if (households.data.some((household) => household.id === cabinetId)) return <Redirect href="/cabinet" />;
  return (
    <View style={{ gap: spacing.lg }}>
      <Body>{tr.sharing.joinedLater}</Body>
      <Button label={tr.tabs.cabinet} onPress={() => router.replace("/cabinet")} />
    </View>
  );
}

/** The link the page opened with, or one pasted here, and what it is to. */
function Invitation({ linked, onJoined }: { linked: string | null; onJoined: (cabinetId: string) => void }) {
  const [typed, setTyped] = useState("");
  const token = linked ?? inviteTokenFrom(typed);
  const peek = usePeek(token);
  return (
    <View style={{ gap: spacing.lg }}>
      {linked ? null : (
        <>
          <Body>{tr.sharing.joinPaste}</Body>
          <TextField
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={tr.sharing.joinLink}
            placeholder={tr.sharing.joinLink}
            error={typed.trim() !== "" && !token ? tr.sharing.joinLinkInvalid : null}
          />
        </>
      )}
      {peek === null ? <Notice tone="error" text={tr.sharing.errInvite} /> : null}
      {peek && "refused" in peek ? <Notice tone="error" text={peek.refused} /> : null}
      {token && peek && !("refused" in peek) ? <Join invite={peek} accept={(name) => acceptInvite(token, name)} onJoined={onJoined} /> : null}
    </View>
  );
}

/** An offer made in the app; `null` when it was answered or withdrawn before the screen opened. */
function Offered({ offer, onJoined }: { offer: CabinetOffer | null; onJoined: (cabinetId: string) => void }) {
  const router = useRouter();
  if (!offer) return <Notice tone="error" text={tr.sharing.errInvite} />;

  const decline = async () => {
    const answer = await answerOffer(offer.cabinetId, false, "");
    if ("refused" in answer) return void appError(answer.refused);
    showNotice(tr.sharing.declined);
    navigateBack(router, "/");
  };
  const accept: Accept = async (name) => {
    const answer = await answerOffer(offer.cabinetId, true, name);
    return "refused" in answer ? answer : { cabinetId: offer.cabinetId };
  };

  return (
    <View style={{ gap: spacing.lg }}>
      <Join invite={{ name: offer.cabinetName, inviter: offer.fromName, role: offer.role }} accept={accept} decline={decline} onJoined={onJoined} />
    </View>
  );
}

/** What `token` is to, asked once per token; `undefined` while it is being asked. */
function usePeek(token: string | null): Peeked | undefined {
  const [peeked, setPeeked] = useState<{ token: string; answer: Peeked } | null>(null);
  useEffect(() => {
    if (!token) return;
    let current = true;
    peekInvite(token).then(
      (answer) => current && setPeeked({ token, answer }),
      () => current && setPeeked({ token, answer: { refused: tr.sharing.errGeneric } }),
    );
    return () => {
      current = false;
    };
  }, [token]);
  // An answer about another token, while the next is being asked, is no answer.
  return peeked?.token === token ? peeked.answer : undefined;
}

/** `decline` is an offer's: one press waits on the other, so a join and a refusal never cross. */
function Join({ invite, accept, decline, onJoined }: { invite: InvitePeek; accept: Accept; decline?: () => Promise<void>; onJoined: (cabinetId: string) => void }) {
  const { me } = useHouseholds();
  const known = useMemberName();
  const [named, setNamed] = useState("");
  const [busy, setBusy] = useState<"join" | "decline" | null>(null);
  const name = known ?? named.trim();

  const hold = async (press: "join" | "decline", work: () => Promise<void>) => {
    setBusy(press);
    try {
      await work();
    } catch {
      void appError(tr.sharing.errGeneric);
    }
    setBusy(null);
  };
  const join = async () => {
    const answer = await accept(name);
    if ("refused" in answer) return void appError(answer.refused);
    selectionTap();
    // The household joined is the one Dolabım opens on.
    await chooseHousehold(answer.cabinetId);
    if (me) await syncNow(me).catch(() => false);
    onJoined(answer.cabinetId);
  };

  return (
    <>
      <Body>{`${tr.sharing.invitedTo(invite.inviter, invite.name)} ${tr.sharing.joinRole(tr.sharing.roles[invite.role])}`}</Body>
      <Body muted>{tr.sharing.joinBody}</Body>
      {known ? null : <TextField label={tr.sharing.nameTitle} value={named} onChangeText={setNamed} maxLength={80} examples={tr.placeholders.person} />}
      <Button label={tr.sharing.joinAccept} icon={LogIn} loading={busy === "join"} disabled={busy !== null || name === ""} onPress={() => void hold("join", join)} />
      {decline ? <Button label={tr.sharing.decline} variant="secondary" loading={busy === "decline"} disabled={busy !== null} onPress={() => void hold("decline", decline)} /> : null}
    </>
  );
}
