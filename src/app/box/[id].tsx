/**
 * One box (`docs/TASKS.md` F1.20, F1.21): what it holds and its own history,
 * whose it is, where it is kept, its days and its photo. Its history is its
 * moves — each use, addition and count — and its edits, newest first;
 * changing this box never changes another of the same product.
 */

import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Check from "lucide-react-native/icons/check";
import Minus from "lucide-react-native/icons/minus";
import Plus from "lucide-react-native/icons/plus";
import Trash from "lucide-react-native/icons/trash";
import Undo2 from "lucide-react-native/icons/undo-2";
import UserCheck from "lucide-react-native/icons/user-check";
import ListChecks from "lucide-react-native/icons/list-checks";

import { addNamed, addTo, correctTo, editBoxes, moveBox, setPhoto, takeFrom, type CabinetBox, type CabinetProduct, type Member, type Named } from "../../data/cabinet";
import { useCabinet, useChanges, useHouseholds, useLocations, useMoves, usePeople } from "../../data/hooks";
import { deleteRows, undoRows } from "../../db/mutations";
import { formatAmount, formatDay, lastOpenDay, parseAmount, parseDay, parseDays, SOON_DAYS, WARN_DAYS_MAX } from "../../domain/boxes";
import type { PACKAGE_DISPOSITIONS } from "../../db/schema";
import type { NewPhoto } from "../../data/photos";
import { tr } from "../../i18n/tr";
import { Body, Button, Card, IconButton, ListRow, Missing, ReadFailed, Screen, SectionHeader } from "../../ui/components";
import { appConfirm, appError, appPrompt } from "../../ui/dialog";
import { LinkedDocuments } from "../../ui/documents";
import { CabinetChoice, changeLines, NamedChoices, useWriter, ViewOnly } from "../../ui/named-choices";
import { navigateBack } from "../../ui/navigation";
import { PhotoField } from "../../ui/photo-field";
import { spacing, type, useTheme } from "../../ui/theme";
import { showNotice, showUndo } from "../../ui/undo";

/** What each of a box's detail rows reads: its value, or that it was not given. */
function said(product: CabinetProduct, box: CabinetBox, unit: string) {
  const day = (value: string | null) => (value ? formatDay(value) : tr.box.unknown);
  const openedUntil = lastOpenDay(box.openedOn, box.useWithinDays);
  return {
    // Under a nickname, the product's own name is what is said first.
    subtitle: tr.common.joined(box.nickname ? product.name : undefined, product.strength ?? undefined, product.form ?? undefined),
    nickname: box.nickname ?? tr.box.unknown,
    expiresOn: day(box.expiresOn),
    openedOn: day(box.openedOn),
    useWithinDays: box.useWithinDays == null ? tr.box.unknown : tr.common.joined(tr.box.days(box.useWithinDays), openedUntil ? tr.cabinet.openUntil(formatDay(openedUntil)) : undefined),
    lowMilli: box.lowMilli == null ? tr.box.lowNone : tr.box.lowAt(formatAmount(box.lowMilli), unit),
    // Its own notice, else its owner's, else the cabinet's.
    warnDays:
      box.warnDays != null
        ? tr.box.warnBefore(box.warnDays)
        : box.soonDays != null
          ? tr.box.warnFromOwner(tr.box.warnBefore(box.soonDays))
          : tr.box.warnDefault(tr.box.warnBefore(SOON_DAYS)),
    acquiredOn: day(box.acquiredOn),
    acquiredFrom: box.acquiredFrom ?? tr.box.unknown,
    serial: box.serial ?? tr.box.unknown,
    lot: box.lot ?? tr.box.unknown,
    note: box.note ?? tr.box.unknown,
  };
}

export default function BoxScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const cabinet = useCabinet();
  const people = usePeople();
  const locations = useLocations();
  const { writes } = useHouseholds();
  const product = cabinet.data.find((each) => each.boxes.some((box) => box.id === id));
  const box = product?.boxes.find((each) => each.id === id);

  if (!product || !box) {
    return (
      <Screen back="/cabinet" title={tr.tabs.cabinet}>
        <Missing query={cabinet} text={tr.box.notFound} />
      </Screen>
    );
  }
  const unit = tr.units[box.unit];
  const editable = writes(box.cabinetId);
  // What only someone who may change the box is given.
  const changing = <T,>(control: T) => (editable ? control : undefined);
  const name = box.nickname ?? product.name;

  // Every write here is one tap; a failure says so rather than leaving the screen as if it took.
  const attempt = async (write: () => Promise<unknown>) => {
    try {
      await write();
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };

  const move = async (kind: "use" | "add" | "count") => {
    const title = kind === "use" ? tr.box.useTitle : kind === "add" ? tr.box.addTitle : tr.box.countTitle;
    const typed = await appPrompt(title, kind === "count" ? tr.box.countMessage(unit) : tr.box.inUnit(unit), {
      confirmLabel: tr.common.save,
      kind: "amount",
      examples: tr.placeholders.amount,
      initialValue: kind === "count" && box.counted ? formatAmount(box.remainingMilli) : "",
      maxLength: 11,
    });
    if (typed == null) return;
    const milli = parseAmount(typed);
    if (milli == null || (milli === 0 && kind !== "count")) return void appError(tr.addBox.amountInvalid);
    await attempt(async () => {
      if (kind === "use") await takeFrom(box.id, milli);
      else if (kind === "add") await addTo(box.id, milli);
      else await correctTo(box.id, milli);
      showNotice(kind === "use" ? tr.box.used(formatAmount(milli), unit) : kind === "add" ? tr.box.added(formatAmount(milli), unit) : tr.box.counted);
    });
  };

  /**
   * Ask for one field and save what is read from it. Emptied, the field is no
   * longer known; anything else `read` refuses is said, with `invalid`.
   */
  const change = async <T,>(
    field: "expiresOn" | "openedOn" | "acquiredOn" | "useWithinDays" | "lowMilli" | "warnDays" | "nickname" | "acquiredFrom" | "note",
    label: string,
    message: string,
    options: Omit<Parameters<typeof appPrompt>[2], "confirmLabel">,
    read: (typed: string) => T | null,
    invalid = "",
  ) => {
    const typed = (await appPrompt(tr.box.changeTitle(label), message, { confirmLabel: tr.common.save, ...options }))?.trim();
    if (typed == null) return;
    const value = typed ? read(typed) : null;
    if (typed && value == null) return void appError(invalid);
    await attempt(() => editBoxes([box.id], { [field]: value }));
  };

  const changeDay = (field: "expiresOn" | "openedOn" | "acquiredOn", label: string, placeholder?: string) =>
    change(field, label, tr.addBox.dayHint, { kind: "day", placeholder, initialValue: box[field] ? formatDay(box[field]) : "", maxLength: 10 }, parseDay, tr.addBox.dayInvalid);

  const changeText = (field: "nickname" | "acquiredFrom" | "note", label: string, maxLength: number, examples: readonly string[]) =>
    change(field, label, "", { examples, initialValue: box[field] ?? "", multiline: field === "note", maxLength }, (typed) => typed);

  const leave = async (disposition: (typeof PACKAGE_DISPOSITIONS)[number] | null) => {
    await attempt(async () => {
      const written = await editBoxes([box.id], { disposition });
      if (disposition && written) showUndo(tr.box.leftNotice(tr.cabinet.dispositions[disposition]), () => undoRows(written));
    });
  };

  const addChoice = async (table: "people" | "locations", name: string) => {
    const named = await addNamed(table, box.cabinetId, name);
    await editBoxes([box.id], table === "people" ? { personId: named } : { locationId: named });
  };

  const remove = async () => {
    if (!(await appConfirm(tr.box.deleteTitle, tr.box.deleteBody, tr.box.delete))) return;
    try {
      const written = await deleteRows("packages", [box.id]);
      navigateBack(router, "/cabinet");
      if (written) showUndo(tr.box.deleted(product.name), () => undoRows(written));
    } catch {
      await appError(tr.errors.deleteFailed);
    }
  };

  const shown = said(product, box, unit);
  const details: [string, string, (() => void) | undefined][] = [
    [tr.box.nickname, shown.nickname, () => void changeText("nickname", tr.box.nickname, 80, tr.box.nicknameExamples)],
    [tr.addBox.expiry, shown.expiresOn, () => void changeDay("expiresOn", tr.addBox.expiry, tr.placeholders.expiry)],
    [tr.addBox.opened, shown.openedOn, () => void changeDay("openedOn", tr.addBox.opened, tr.placeholders.opened)],
    [
      tr.box.useWithin,
      shown.useWithinDays,
      () =>
        void change("useWithinDays", tr.box.useWithin, tr.box.useWithinHint, { kind: "amount", examples: ["28", "30", "90"], initialValue: box.useWithinDays?.toString() ?? "", maxLength: 4 }, parseDays, tr.box.daysInvalid),
    ],
    [
      tr.box.low,
      shown.lowMilli,
      () =>
        void change("lowMilli", tr.box.low, tr.box.lowHint(unit), { kind: "amount", examples: tr.placeholders.amount, initialValue: box.lowMilli == null ? "" : formatAmount(box.lowMilli), maxLength: 11 }, (typed) => parseAmount(typed) || null, tr.addBox.amountInvalid),
    ],
    [
      tr.box.warn,
      shown.warnDays,
      () =>
        void change("warnDays", tr.box.warn, tr.box.warnHint, { kind: "amount", examples: ["7", "30", "90"], initialValue: box.warnDays?.toString() ?? "", maxLength: 3 }, (typed) => parseDays(typed, WARN_DAYS_MAX), tr.box.warnInvalid),
    ],
    [tr.box.acquiredOn, shown.acquiredOn, () => void changeDay("acquiredOn", tr.box.acquiredOn)],
    [tr.box.acquiredFrom, shown.acquiredFrom, () => void changeText("acquiredFrom", tr.box.acquiredFrom, 200, tr.box.acquiredFromExamples)],
    [tr.addBox.serial, shown.serial, undefined],
    [tr.addBox.lot, shown.lot, undefined],
    [tr.box.note, shown.note, () => void changeText("note", tr.box.note, 2000, tr.box.noteExamples)],
  ];
  // Read, the choices below are two lines here.
  const nameIn = (named: readonly Named[], id: string | null) => named.find((each) => each.id === id)?.name ?? tr.cabinet.unassigned;
  if (!editable) details.push([tr.addBox.whoseSection, nameIn(people.data, box.personId), undefined], [tr.addBox.whereSection, nameIn(locations.data, box.locationId), undefined]);

  return (
    <Screen
      back="/cabinet"
      title={name}
      actions={changing(<IconButton icon={Trash} label={tr.box.delete} tone="danger" onPress={() => void remove()} />)}
    >
      <ViewOnly cabinetId={box.cabinetId} />
      {shown.subtitle ? <Body muted style={{ marginBottom: spacing.md }}>{shown.subtitle}</Body> : null}
      {box.disposition ? <Left disposition={box.disposition} onBringBack={changing(() => void leave(null))} /> : null}
      <Remaining box={box} unit={unit} onMove={changing((kind: "use" | "add" | "count") => void move(kind))} />

      <CheckAsked box={box} editable={editable} />

      <PhotoField name={name} photoId={box.photoId} thumb={box.thumb} onChange={changing((photo: NewPhoto | null) => void attempt(() => setPhoto("packages", box.id, photo)))} />

      <SectionHeader>{tr.box.detailsSection}</SectionHeader>
      <Card rows>
        {details.map(([label, value, onPress]) => (
          <ListRow key={label} title={label} subtitle={value} chevron={editable && onPress != null} onPress={editable ? onPress : undefined} />
        ))}
      </Card>

      {editable ? (
        <>
          <Placement box={box} />
          <AskCheck box={box} />
          <NamedChoices table="people" named={people.data.filter((person) => person.cabinetId === box.cabinetId)} chosen={box.personId} onChoose={(personId) => void attempt(() => editBoxes([box.id], { personId }))} onAdd={(name) => addChoice("people", name)} />
          <NamedChoices
            table="locations"
            named={locations.data.filter((place) => place.cabinetId === box.cabinetId)}
            chosen={box.locationId}
            onChoose={(locationId) => void attempt(() => editBoxes([box.id], { locationId }))}
            onAdd={(name) => addChoice("locations", name)}
          />
        </>
      ) : null}

      <LinkedDocuments target={{ package: box.id }} editable={editable} />

      <History box={box} unit={unit} people={people.data} locations={locations.data} />

      {box.disposition || !editable ? null : <Leave onLeave={(each) => void leave(each)} />}
    </Screen>
  );
}

/** What was done to the box, newest first, and by whom. */
function History({ box, unit, people, locations }: { box: CabinetBox; unit: string; people: readonly Named[]; locations: readonly Named[] }) {
  const moves = useMoves(box.id);
  const changes = useChanges(box.id);
  const writer = useWriter(box.cabinetId);
  // Moves and edits as one history; an id is a uuidv7, so a tie keeps the order they were written in.
  const history = [
    ...moves.data.map((each) => ({
      id: each.id,
      at: each.createdAt,
      title: tr.box.move(each.reason, each.quantityMilli, unit),
      by: each.createdBy,
      lines: undefined as string | undefined,
    })),
    ...changes.data.map((each) => ({ id: each.id, at: each.createdAt, title: tr.box.changed, by: each.createdBy, lines: changeLines(each.changes, unit, people, locations, writer) || undefined })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  return (
    <>
      <SectionHeader>{tr.box.historySection}</SectionHeader>
      {moves.status === "error" || changes.status === "error" ? (
        <ReadFailed queries={[moves, changes]} />
      ) : moves.status === "loading" || changes.status === "loading" ? null : history.length === 0 ? (
        <Body muted>{tr.box.noHistory}</Body>
      ) : (
        <Card rows>
          {history.map((each) => (
            <ListRow key={each.id} title={each.title} subtitle={tr.common.joined(each.lines, writer(each.by), tr.box.when(each.at))} />
          ))}
        </Card>
      )}
    </>
  );
}

/**
 * Whether the household sees the box (`docs/TASKS.md` F2.5): the household
 * it is in, or the open one for a box of the person's own. Moved, the box is
 * a new row, so the page follows it to its new id, and back on an undo.
 */
function Placement({ box }: { box: CabinetBox }) {
  const router = useRouter();
  const { me, open, households, writes } = useHouseholds();
  const household = households.data.find((each) => each.id === box.cabinetId) ?? (open && writes(open.id) ? open : null);
  const own = box.cabinetId === me;
  const go = (id: string) => router.replace({ pathname: "/box/[id]", params: { id } });
  const choose = async (toOwn: boolean) => {
    if (toOwn === own || !me || !household) return;
    try {
      const moved = await moveBox(box.id, toOwn ? me : household.id);
      if (!moved) return;
      go(moved.id);
      showUndo(toOwn ? tr.box.movedPrivate : tr.box.movedTo(household.name), async () => {
        await undoRows(moved.written);
        go(box.id);
      });
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };
  return <CabinetChoice household={household} own={own} title={tr.box.seenBySection} onChoose={(toOwn) => void choose(toOwn)} />;
}

/** An open ask to check the box (`docs/TASKS.md` F2.9), and for whoever may change it the word that it is done. */
function CheckAsked({ box, editable }: { box: CabinetBox; editable: boolean }) {
  const { me } = useHouseholds();
  const writer = useWriter(box.cabinetId);
  if (!box.checkOf) return null;
  const done = () => editBoxes([box.id], { checkOf: null, checkAskedAt: null }).then(() => showNotice(tr.box.checkDone), () => appError(tr.errors.saveFailed));
  return (
    <Card>
      <Body>{box.checkOf === me ? tr.box.checkAskedOfYou : tr.box.checkAsked(writer(box.checkOf) ?? tr.sharing.unnamed)}</Body>
      {box.checkAskedAt ? <Body muted>{tr.box.when(box.checkAskedAt)}</Body> : null}
      {editable ? (
        <View style={{ alignItems: "flex-start", marginTop: spacing.sm }}>
          <Button label={tr.box.checked} icon={Check} variant="secondary" onPress={() => void done()} />
        </View>
      ) : null}
    </Card>
  );
}

/** Whom of the household's other writers to ask to check the box; absent while an ask is open or with none to ask. */
function AskCheck({ box }: { box: CabinetBox }) {
  const { me, households } = useHouseholds();
  const others = households.data.find((each) => each.id === box.cabinetId)?.members.filter((member) => member.userId !== me && member.role !== "viewer") ?? [];
  if (box.checkOf || others.length === 0) return null;
  const ask = (member: Member) =>
    editBoxes([box.id], { checkOf: member.userId, checkAskedAt: new Date().toISOString() }).then(() => showNotice(tr.box.checkSent(member.name || tr.sharing.unnamed)), () => appError(tr.errors.saveFailed));
  return (
    <>
      <SectionHeader>{tr.box.askSection}</SectionHeader>
      <Body muted style={{ marginBottom: spacing.sm }}>{tr.box.askHint}</Body>
      <Card rows>
        {others.map((member) => (
          <ListRow key={member.id} icon={UserCheck} title={member.name || tr.sharing.unnamed} chevron onPress={() => void ask(member)} />
        ))}
      </Card>
    </>
  );
}

function Left({ disposition, onBringBack }: { disposition: (typeof PACKAGE_DISPOSITIONS)[number]; onBringBack?: () => void }) {
  return (
    <Card>
      <Body>{tr.box.left(tr.cabinet.dispositions[disposition])}</Body>
      {onBringBack ? (
        <View style={{ alignItems: "flex-start", marginTop: spacing.sm }}>
          <Button label={tr.box.bringBack} icon={Undo2} variant="secondary" onPress={onBringBack} />
        </View>
      ) : null}
    </Card>
  );
}

/** What is left, and for whoever may change it a use, an addition or a count. */
function Remaining({ box, unit, onMove }: { box: CabinetBox; unit: string; onMove?: (kind: "use" | "add" | "count") => void }) {
  const { palette } = useTheme();
  return (
    <Card>
      <Text style={[type.label, { color: palette.textMuted }]}>{tr.box.remaining}</Text>
      <Text style={[type.amount, { color: palette.text }]}>{box.counted ? `${formatAmount(box.remainingMilli)} ${unit}` : tr.cabinet.uncounted}</Text>
      {onMove ? (
        <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Button label={tr.box.use} icon={Minus} onPress={() => onMove("use")} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={tr.box.add} icon={Plus} variant="secondary" onPress={() => onMove("add")} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={tr.box.count} icon={ListChecks} variant="secondary" onPress={() => onMove("count")} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/** A box no longer at home, and for whoever may change it the way back. */
function Leave({ onLeave }: { onLeave: (disposition: (typeof PACKAGE_DISPOSITIONS)[number]) => void }) {
  return (
    <>
      <SectionHeader>{tr.box.leaveSection}</SectionHeader>
      <Body muted style={{ marginBottom: spacing.sm }}>{tr.box.leaveHint}</Body>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {(["archived", "lost", "disposed"] as const).map((each) => (
          <Button key={each} label={tr.box.leave[each]} variant="secondary" size="sm" onPress={() => onLeave(each)} />
        ))}
      </View>
    </>
  );
}
