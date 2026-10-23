/**
 * One box (`docs/TASKS.md` F1.20, F1.21): what it holds and its own history,
 * whose it is, where it is kept, its days and its photo. Its history is its
 * moves — each use, addition and count — and its edits, newest first;
 * changing this box never changes another of the same product.
 */

import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Minus from "lucide-react-native/icons/minus";
import Plus from "lucide-react-native/icons/plus";
import Trash from "lucide-react-native/icons/trash";
import Undo2 from "lucide-react-native/icons/undo-2";
import ListChecks from "lucide-react-native/icons/list-checks";

import { addNamed, addTo, correctTo, editBoxes, setPhoto, takeFrom, type BoxChange, type CabinetBox, type CabinetProduct, type Named } from "../../data/cabinet";
import { useCabinet, useChanges, useLocations, useMoves, usePeople } from "../../data/hooks";
import { deleteRows, undoRows } from "../../db/mutations";
import { formatAmount, formatDay, lastOpenDay, parseAmount, parseDay, parseDays, SOON_DAYS, WARN_DAYS_MAX } from "../../domain/boxes";
import type { PACKAGE_DISPOSITIONS } from "../../db/schema";
import { tr } from "../../i18n/tr";
import { Body, Button, Card, IconButton, ListRow, Notice, Screen, SectionHeader } from "../../ui/components";
import { appConfirm, appError, appPrompt } from "../../ui/dialog";
import { NamedChoices } from "../../ui/named-choices";
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

/** What each edited field is called in the history. */
const CHANGED: Partial<Record<string, string>> = {
  nickname: tr.box.nickname,
  expiresOn: tr.addBox.expiry,
  openedOn: tr.addBox.opened,
  useWithinDays: tr.box.useWithin,
  lowMilli: tr.box.low,
  warnDays: tr.box.warn,
  acquiredOn: tr.box.acquiredOn,
  acquiredFrom: tr.box.acquiredFrom,
  note: tr.box.note,
  personId: tr.addBox.whoseSection,
  locationId: tr.addBox.whereSection,
  disposition: tr.box.disposition,
};
const DAYS = new Set(["expiresOn", "openedOn", "acquiredOn"]);

/** One line of an edit: the field, what it was and what it became, each as the page shows it. */
function changeLine(field: string, [before, after]: [unknown, unknown], unit: string, people: readonly Named[], places: readonly Named[]): string | null {
  if (field === "photoId") return `${tr.photos.title}: ${tr.box.photoChange[before == null ? "added" : after == null ? "removed" : "replaced"]}`;
  const label = CHANGED[field];
  if (!label) return null;
  const shown = (value: unknown): string => {
    if (value == null) return field === "disposition" ? tr.box.atHome : tr.box.unknown;
    if (DAYS.has(field)) return formatDay(String(value));
    if (field === "personId" || field === "locationId") return (field === "personId" ? people : places).find((each) => each.id === value)?.name ?? tr.cabinet.unassigned;
    if (field === "disposition") return tr.cabinet.dispositions[value as (typeof PACKAGE_DISPOSITIONS)[number]];
    if (field === "lowMilli") return tr.box.lowAt(formatAmount(Number(value)), unit);
    if (field === "useWithinDays" || field === "warnDays") return tr.box.days(Number(value));
    return String(value);
  };
  return `${label}: ${shown(before)} → ${shown(after)}`;
}

function changeLines(change: BoxChange, unit: string, people: readonly Named[], places: readonly Named[]): string {
  return Object.entries(change.changes)
    .map(([field, pair]) => changeLine(field, pair, unit, people, places))
    .filter((line) => line != null)
    .join("\n");
}

export default function BoxScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  const cabinet = useCabinet();
  const moves = useMoves(id);
  const changes = useChanges(id);
  const people = usePeople();
  const locations = useLocations();
  const product = cabinet.data.find((each) => each.boxes.some((box) => box.id === id));
  const box = product?.boxes.find((each) => each.id === id);

  if (!product || !box) {
    return (
      <Screen back="/cabinet" title={tr.tabs.cabinet}>
        {cabinet.status === "loading" ? null : <Notice tone="error" text={tr.box.notFound} />}
      </Screen>
    );
  }
  const unit = tr.units[box.unit];

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
  // Moves and edits as one history; an id is a uuidv7, so a tie keeps the order they were written in.
  const history = [
    ...moves.data.map((each) => ({
      id: each.id,
      at: each.createdAt,
      title: `${tr.box.reasons[each.reason]} ${each.quantityMilli > 0 ? "+" : "−"}${formatAmount(Math.abs(each.quantityMilli))} ${unit}`,
      lines: undefined as string | undefined,
    })),
    ...changes.data.map((each) => ({ id: each.id, at: each.createdAt, title: tr.box.changed, lines: changeLines(each, unit, people.data, locations.data) || undefined })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
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

  return (
    <Screen
      back="/cabinet"
      title={box.nickname ?? product.name}
      actions={<IconButton icon={Trash} label={tr.box.delete} tone="danger" onPress={() => void remove()} />}
    >
      {shown.subtitle ? <Body muted style={{ marginBottom: spacing.md }}>{shown.subtitle}</Body> : null}
      {box.disposition ? (
        <Card>
          <Body>{tr.box.left(tr.cabinet.dispositions[box.disposition])}</Body>
          <View style={{ alignItems: "flex-start", marginTop: spacing.sm }}>
            <Button label={tr.box.bringBack} icon={Undo2} variant="secondary" onPress={() => void leave(null)} />
          </View>
        </Card>
      ) : null}

      <Card>
        <Text style={[type.label, { color: palette.textMuted }]}>{tr.box.remaining}</Text>
        <Text style={[type.amount, { color: palette.text }]}>{box.counted ? `${formatAmount(box.remainingMilli)} ${unit}` : tr.cabinet.uncounted}</Text>
        <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Button label={tr.box.use} icon={Minus} onPress={() => void move("use")} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={tr.box.add} icon={Plus} variant="secondary" onPress={() => void move("add")} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={tr.box.count} icon={ListChecks} variant="secondary" onPress={() => void move("count")} />
          </View>
        </View>
      </Card>

      <PhotoField name={box.nickname ?? product.name} photoId={box.photoId} thumb={box.thumb} onChange={(photo) => void attempt(() => setPhoto("packages", box.id, photo))} />

      <SectionHeader>{tr.box.detailsSection}</SectionHeader>
      <Card rows>
        {details.map(([label, value, onPress]) => (
          <ListRow key={label} title={label} subtitle={value} chevron={onPress != null} onPress={onPress} />
        ))}
      </Card>

      <NamedChoices table="people" named={people.data} chosen={box.personId} onChoose={(personId) => void attempt(() => editBoxes([box.id], { personId }))} onAdd={(name) => addChoice("people", name)} />
      <NamedChoices
        table="locations"
        named={locations.data}
        chosen={box.locationId}
        onChoose={(locationId) => void attempt(() => editBoxes([box.id], { locationId }))}
        onAdd={(name) => addChoice("locations", name)}
      />

      <SectionHeader>{tr.box.historySection}</SectionHeader>
      {history.length === 0 ? (
        <Body muted>{tr.box.noHistory}</Body>
      ) : (
        <Card rows>
          {history.map((each) => (
            <ListRow key={each.id} title={each.title} subtitle={tr.common.joined(each.lines, tr.box.when(each.at))} />
          ))}
        </Card>
      )}

      {box.disposition ? null : (
        <>
          <SectionHeader>{tr.box.leaveSection}</SectionHeader>
          <Body muted style={{ marginBottom: spacing.sm }}>{tr.box.leaveHint}</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {(["archived", "lost", "disposed"] as const).map((each) => (
              <Button key={each} label={tr.box.leave[each]} variant="secondary" size="sm" onPress={() => void leave(each)} />
            ))}
          </View>
        </>
      )}
    </Screen>
  );
}

