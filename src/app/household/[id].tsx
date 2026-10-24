/**
 * A household's people (`docs/TASKS.md` F2.3, F2.2): who is in it and as
 * what, its photo, and for its owner the invitations, a role changed and a
 * member removed; anyone else leaves from here. Gital's `src/ui/members-sheet.tsx`
 * as a pushed screen, since Fiala reaches it from Ayarlar and from "Hangi
 * Hane?" rather than from a list's header.
 */

import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import Eye from "lucide-react-native/icons/eye";
import Link from "lucide-react-native/icons/link";
import LogOut from "lucide-react-native/icons/log-out";
import Pencil from "lucide-react-native/icons/pencil";
import Share from "lucide-react-native/icons/share";
import Trash from "lucide-react-native/icons/trash";
import User from "lucide-react-native/icons/user";
import UserMinus from "lucide-react-native/icons/user-minus";

import { removeMember, renameNamed, setMemberRole, setPhoto, type Activity as Entry, type Household, type Member } from "../../data/cabinet";
import { useActivity, useHouseholds, useLocations, useMemberName, usePeople } from "../../data/hooks";
import { deleteRows, undoRows } from "../../db/mutations";
import { tr } from "../../i18n/tr";
import { shareText } from "../../services/share";
import { syncNow } from "../../sync/engine";
import { cancelInvites, createInvite, inviteLink, listOffers, offerCabinet, type InviteRole } from "../../sync/sharing";
import { Body, Button, Card, ChoiceTile, IconButton, ListRow, Notice, ReadFailed, Screen, SectionHeader, TextField } from "../../ui/components";
import { appConfirm, appError, appPrompt } from "../../ui/dialog";
import { selectionTap } from "../../ui/haptics";
import { radioGroupKeys } from "../../ui/keys";
import { navigateBack } from "../../ui/navigation";
import { changeLines, useWriter } from "../../ui/named-choices";
import { PhotoField } from "../../ui/photo-field";
import { controlSize, radius, spacing, type, useTheme } from "../../ui/theme";
import { showNotice, showUndo } from "../../ui/undo";

const ROLES: readonly InviteRole[] = ["editor", "viewer"];
const nameOf = (member: Member) => member.name || tr.sharing.unnamed;

export default function HouseholdScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { me, households } = useHouseholds();
  const household = households.data.find((each) => each.id === id);
  if (!household || !me) {
    // Left, removed or deleted since the link was opened: said, not a blank page.
    return (
      <Screen back="/households" title={households.updatedAt == null ? undefined : tr.households.title}>
        {households.status === "error" ? <ReadFailed queries={[households]} /> : households.updatedAt == null || !me ? null : <Notice tone="error" text={tr.households.notFound} />}
      </Screen>
    );
  }
  const owner = household.ownerId === me;

  const rename = async () => {
    const name = (await appPrompt(tr.sharing.rename, "", { confirmLabel: tr.common.save, initialValue: household.name, maxLength: 60 }))?.trim();
    if (name && name !== household.name) await renameNamed("cabinets", household.id, name).catch(() => appError(tr.errors.saveFailed));
  };
  // Its rows stay under the tombstone for a week, so the undo bar brings the household back whole.
  const remove = async () => {
    if (!(await appConfirm(tr.sharing.deleteTitle(household.name), tr.sharing.deleteMessage, tr.sharing.deleteConfirm))) return;
    try {
      const written = await deleteRows("cabinets", [household.id]);
      navigateBack(router, "/households");
      if (written) showUndo(tr.common.deleted(household.name), () => undoRows(written));
    } catch {
      await appError(tr.errors.deleteFailed);
    }
  };
  const leave = async () => {
    const mine = household.members.find((member) => member.userId === me);
    if (!mine || !(await appConfirm(tr.sharing.leaveTitle(household.name), tr.sharing.leaveMessage, tr.sharing.leaveConfirm))) return;
    try {
      await removeMember(mine.id);
      showNotice(tr.sharing.left(household.name));
      navigateBack(router, "/households");
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };

  return (
    <Screen
      back="/households"
      title={household.name}
      actions={
        owner ? (
          <>
            <IconButton icon={Pencil} label={tr.sharing.rename} onPress={() => void rename()} />
            <IconButton icon={Trash} label={tr.sharing.deleteHousehold(household.name)} tone="danger" onPress={() => void remove()} />
          </>
        ) : null
      }
    >
      <PhotoField name={household.name} photoId={household.photoId} thumb={household.thumb} onChange={owner ? (change) => void setPhoto("cabinets", household.id, change).catch(() => appError(tr.errors.saveFailed)) : undefined} />
      <SectionHeader>{tr.sharing.members}</SectionHeader>
      {household.members.length === 0 ? (
        <Body muted style={{ marginBottom: spacing.md }}>{tr.households.people([])}</Body>
      ) : (
        <Card rows>
          {household.members.map((member) => (
            <MemberRow key={member.id} member={member} me={member.userId === me} manage={owner && member.role !== "owner"} />
          ))}
        </Card>
      )}
      <Activity cabinetId={household.id} />
      {owner ? (
        <>
          <Invite household={household} me={me} />
          <Offers household={household} me={me} others={households.data} />
        </>
      ) : (
        <View style={{ alignItems: "flex-start", marginTop: spacing.lg }}>
          <Button label={tr.sharing.leave} icon={LogOut} variant="secondary" onPress={() => void leave()} />
        </View>
      )}
    </Screen>
  );
}

/** Who moved or changed which box lately (`docs/TASKS.md` F2.8); a row opens the box. */
function Activity({ cabinetId }: { cabinetId: string }) {
  const router = useRouter();
  const activity = useActivity(cabinetId);
  const writer = useWriter(cabinetId);
  const people = usePeople().data;
  const places = useLocations().data;
  // An edit says what it changed, as the box's own history does.
  const said = (each: Entry) =>
    each.changes ? changeLines(each.changes, tr.units[each.unit], people, places, writer) || tr.box.changed : tr.box.move(each.reason!, each.quantityMilli ?? 0, tr.units[each.unit]);
  return (
    <>
      <SectionHeader>{tr.sharing.activity}</SectionHeader>
      {activity.status === "error" ? (
        <ReadFailed queries={[activity]} />
      ) : activity.status === "loading" ? null : activity.data.length === 0 ? (
        <Body muted style={{ marginBottom: spacing.md }}>{tr.sharing.noActivity}</Body>
      ) : (
        <Card rows>
          {activity.data.map((each) => (
            <ListRow
              key={each.id}
              title={each.name}
              subtitle={tr.common.joined(said(each), writer(each.by), tr.box.when(each.at))}
              chevron
              onPress={() => router.push(`/box/${each.boxId}`)}
            />
          ))}
        </Card>
      )}
    </>
  );
}

function MemberRow({ member, me, manage }: { member: Member; me: boolean; manage: boolean }) {
  const name = nameOf(member);
  const viewer = member.role === "viewer";
  const act = (work: () => Promise<void>) => work().then(selectionTap, () => appError(tr.errors.saveFailed));
  const remove = async () => {
    if (await appConfirm(tr.sharing.removeTitle, tr.sharing.removeMessage(name), tr.sharing.removeConfirm)) await act(() => removeMember(member.id));
  };
  return (
    <ListRow
      icon={User}
      title={me ? tr.sharing.you(name) : name}
      subtitle={tr.sharing.roles[member.role]}
      right={
        manage ? (
          <View style={{ flexDirection: "row", gap: spacing.xs }}>
            <IconButton icon={viewer ? Pencil : Eye} label={viewer ? tr.sharing.makeEditor(name) : tr.sharing.makeViewer(name)} onPress={() => void act(() => setMemberRole(member.id, viewer ? "editor" : "viewer"))} />
            <IconButton icon={UserMinus} label={tr.sharing.remove(name)} tone="danger" onPress={() => void remove()} />
          </View>
        ) : undefined
      }
    />
  );
}

/** One link per person, made on the server; the household is sent first when the server has not got it yet. */
function Invite({ household, me }: { household: Household; me: string }) {
  const { palette } = useTheme();
  const known = useMemberName();
  const [typed, setTyped] = useState("");
  const [role, setRole] = useState<InviteRole>("editor");
  const [link, setLink] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const name = known ?? typed.trim();

  const create = async () => {
    if (name === "") return setAttempted(true);
    setBusy(true);
    setRefused(null);
    try {
      const made = await createInvite(household.id, role, name, () => syncNow(me));
      if ("refused" in made) setRefused(made.refused);
      else {
        selectionTap();
        setLink(inviteLink(made.token));
      }
    } catch {
      setRefused(tr.sharing.errGeneric);
    }
    setBusy(false);
  };
  const share = async (url: string) => {
    try {
      if ((await shareText(tr.sharing.inviteText(household.name, url))) === "clipboard") showNotice(tr.sharing.inviteCopied);
    } catch {
      await appError(tr.errors.shareFailed);
    }
  };
  const cancel = async () => {
    const answer = await cancelInvites(household.id).catch(() => ({ refused: tr.sharing.errGeneric }));
    if ("refused" in answer) return setRefused(answer.refused);
    setLink(null);
    showNotice(tr.sharing.cancelled(answer.cancelled));
  };
  const choose = (next: InviteRole) => {
    setRole(next);
    // A link already made carries the role it was made with.
    setLink(null);
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionHeader>{tr.sharing.invite}</SectionHeader>
      <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.sharing.inviteRole} style={{ flexDirection: "row", gap: spacing.sm }}>
        {ROLES.map((choice) => (
          <ChoiceTile key={choice} label={tr.sharing.roles[choice]} selected={role === choice} minHeight={controlSize.minimumTarget} onPress={() => choose(choice)} />
        ))}
      </View>
      <Body muted>{tr.sharing.inviteHint}</Body>
      {known ? null : (
        <TextField label={tr.sharing.nameTitle} value={typed} onChangeText={setTyped} maxLength={80} examples={tr.placeholders.person} error={attempted && name === "" ? tr.sharing.nameRequired : null} />
      )}
      {refused ? <Notice tone="error" text={refused} /> : null}
      {link ? (
        <>
          <Text selectable numberOfLines={1} ellipsizeMode="middle" style={[type.small, { color: palette.textSecondary, backgroundColor: palette.surfaceAlt, borderRadius: radius.sm, padding: spacing.md }]}>
            {link}
          </Text>
          <Button label={tr.sharing.inviteShare} icon={Share} onPress={() => void share(link)} />
        </>
      ) : (
        <Button label={tr.sharing.inviteCreate} icon={Link} loading={busy} disabled={busy} onPress={() => void create()} />
      )}
      <View style={{ alignItems: "flex-start" }}>
        <Button label={tr.sharing.cancelInvites} variant="ghost" size="sm" onPress={() => void cancel()} />
      </View>
    </View>
  );
}

/**
 * The people the owner already shares another household with, offered this
 * one in the app with no link (Gital's offers). The server answers who has an
 * offer waiting; until it has, nobody shows as offered.
 */
function Offers({ household, me, others }: { household: Household; me: string; others: readonly Household[] }) {
  const known = useMemberName();
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<string | null>(null);
  const reload = useCallback(() => {
    let current = true;
    void listOffers().then(
      (answer) => {
        if (!current) return;
        if ("refused" in answer) return setRefused(answer.refused);
        setWaiting(new Set(answer.offers.filter((offer) => offer.cabinetId === household.id && offer.to !== me).map((offer) => offer.to)));
      },
      () => current && setRefused(tr.sharing.errGeneric),
    );
    return () => {
      current = false;
    };
  }, [household.id, me]);
  useFocusEffect(reload);

  const inside = new Set(household.members.map((member) => member.userId));
  const people = [
    ...new Map(
      others
        .filter((other) => other.id !== household.id)
        .flatMap((other) => other.members)
        .filter((member) => !inside.has(member.userId) && member.userId !== me)
        .map((member) => [member.userId, member] as const),
    ).values(),
  ];
  if (people.length === 0 || !known) return null;

  const offer = async (person: Member, on: boolean) => {
    setRefused(null);
    const answer = await offerCabinet(household.id, person.userId, on ? "editor" : null, known, () => syncNow(me)).catch(() => ({ refused: tr.sharing.errGeneric }));
    if ("refused" in answer) return setRefused(answer.refused);
    selectionTap();
    reload();
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionHeader>{tr.sharing.offerSection}</SectionHeader>
      <Body muted>{tr.sharing.offerHint}</Body>
      {refused ? <Notice tone="error" text={refused} /> : null}
      <Card rows>
        {people.map((person) => {
          const name = nameOf(person);
          const offered = waiting.has(person.userId);
          return (
            <ListRow
              key={person.userId}
              icon={User}
              title={name}
              subtitle={offered ? tr.sharing.offered : undefined}
              right={
                <Button
                  label={offered ? tr.sharing.withdraw : tr.sharing.offer}
                  variant={offered ? "ghost" : "secondary"}
                  size="sm"
                  onPress={() => void offer(person, !offered)}
                />
              }
            />
          );
        })}
      </Card>
    </View>
  );
}
