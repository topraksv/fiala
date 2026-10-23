/**
 * Whose a box is, or where it is kept: the cabinet's names as tiles, with
 * "Atanmamış" first, and a way to add a name without leaving the screen. A
 * person's tile carries their mark, so their boxes are told apart at a glance.
 * Which cabinet a new box goes to comes before them, since the names are that cabinet's.
 */

import { useState } from "react";
import { Image, Text, View } from "react-native";
import MapPinPlus from "lucide-react-native/icons/map-pin-plus";
import PawPrint from "lucide-react-native/icons/paw-print";
import UserPlus from "lucide-react-native/icons/user-plus";

import type { BoxChange, Named, Person } from "../data/cabinet";
import { useHouseholds } from "../data/hooks";
import { PERSON_COLORS, type PACKAGE_DISPOSITIONS } from "../db/schema";
import { formatAmount, formatDay } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { Body, Button, ChoiceTile, SectionHeader, rowsOf } from "./components";
import { appError, appPrompt } from "./dialog";
import { radioGroupKeys } from "./keys";
import { circle, controlSize, font, personColors, personMark, spacing, type, useTheme } from "./theme";

/** The colour of a person given none: the one their id falls on, so it is the same on every device. */
export function colorOf(person: Pick<Person, "id" | "color">): (typeof PERSON_COLORS)[number] {
  if (person.color) return person.color;
  const sum = [...person.id].reduce((total, char) => total + char.charCodeAt(0), 0);
  return PERSON_COLORS[sum % PERSON_COLORS.length]!;
}

/** A person's photo, or their initial on their colour, a pet's paw. Its name is said by what it stands beside. */
export function PersonMark({ person, size = personMark.size }: { person: Pick<Person, "id" | "name" | "color" | "thumb"> & { kind?: Person["kind"] }; size?: number }) {
  const { palette, scheme } = useTheme();
  const disc = { width: size, height: size, borderRadius: circle(size) };
  if (person.thumb) return <Image source={{ uri: person.thumb }} accessible={false} style={disc} />;
  return (
    <View accessible={false} style={{ ...disc, backgroundColor: personColors[scheme][colorOf(person)], alignItems: "center", justifyContent: "center" }}>
      {person.kind === "pet" ? (
        <PawPrint size={size / 2} color={palette.surface} />
      ) : (
        <Text style={[size > personMark.size ? type.title : type.small, { color: palette.surface, fontFamily: font.semibold }]}>
          {[...person.name.trim()][0]?.toLocaleUpperCase("tr")}
        </Text>
      )}
    </View>
  );
}

/** Said atop a page of a household the person only reads, whose controls are then gone (`docs/TASKS.md` F2.3). */
export function ViewOnly({ cabinetId }: { cabinetId: string }) {
  const { households, writes } = useHouseholds();
  const household = households.data.find((each) => each.id === cabinetId);
  return household && !writes(cabinetId) ? <Body muted style={{ marginBottom: spacing.md }}>{tr.sharing.viewOnly(household.name)}</Body> : null;
}

/**
 * Who wrote a row of a household's history, by the name they joined with
 * (`docs/TASKS.md` F2.8). A personal cabinet's are all its owner's, and a row
 * from before the server named its writer, or from someone who has left,
 * says nobody.
 */
export type Writer = (userId: string | null) => string | undefined;

export function useWriter(cabinetId: string | undefined): Writer {
  const { me, households } = useHouseholds();
  const members = households.data.find((each) => each.id === cabinetId)?.members ?? [];
  return (userId: string | null) => {
    const member = members.find((each) => each.userId === userId);
    if (!member) return undefined;
    const name = member.name || tr.sharing.unnamed;
    return member.userId === me ? tr.sharing.you(name) : name;
  };
}

/** Where a new box goes: the household open unless the person keeps it to themselves (`docs/TASKS.md` F2.4). */
export function useCabinetChoice() {
  const { me, open, writes } = useHouseholds();
  const [own, setOwn] = useState(false);
  // A household the person only reads takes nothing new: what they add stays theirs.
  const target = open && writes(open.id) ? open : null;
  return { open: target, own, setOwn, cabinetId: own ? me : (target?.id ?? me) };
}

/** The household open, or the person's own cabinet; absent while there is no household to choose. */
export function CabinetChoice({
  household,
  own,
  onChoose,
  title = tr.addBox.targetSection,
}: {
  household: { name: string } | null;
  own: boolean;
  onChoose: (own: boolean) => void;
  title?: string;
}) {
  if (!household) return null;
  return (
    <>
      <SectionHeader>{title}</SectionHeader>
      <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={title} style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md }}>
        <ChoiceTile label={household.name} selected={!own} minHeight={controlSize.minimumTarget} onPress={() => onChoose(false)} />
        <ChoiceTile label={tr.households.private} selected={own} minHeight={controlSize.minimumTarget} onPress={() => onChoose(true)} />
      </View>
    </>
  );
}

export function NamedChoices({
  table,
  title,
  named,
  chosen,
  onChoose,
  onAdd,
}: {
  table: "people" | "locations";
  title?: string;
  /** People with their mark; places as names alone. */
  named: readonly (Named | Person)[];
  /** Absent while boxes that differ are chosen together: no tile is theirs. */
  chosen?: string | null;
  onChoose: (id: string | null) => void;
  /** Writes the name typed; the screen chooses it, since what choosing writes is the screen's. */
  onAdd: (name: string) => Promise<unknown>;
}) {
  const person = table === "people";
  const heading = title ?? (person ? tr.addBox.whoseSection : tr.addBox.whereSection);
  const add = async () => {
    const name = (
      await appPrompt(person ? tr.addBox.addPersonTitle : tr.addBox.addLocationTitle, person ? tr.addBox.addPersonMessage : tr.addBox.addLocationMessage, {
        confirmLabel: tr.addBox.add,
        examples: person ? tr.placeholders.person : tr.placeholders.location,
        maxLength: 80,
      })
    )?.trim();
    if (!name) return;
    try {
      await onAdd(name);
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };
  const options: readonly (Named | Person | { id: null; name: string })[] = [{ id: null, name: tr.cabinet.unassigned }, ...named];
  return (
    <>
      <SectionHeader>{heading}</SectionHeader>
      <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={heading} style={{ gap: spacing.sm, marginBottom: spacing.sm }}>
        {rowsOf(options, 2).map((row, at) => (
          <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
            {row.map((option) => (
              <ChoiceTile
                key={option.id ?? "none"}
                label={option.name}
                selected={chosen === option.id}
                minHeight={controlSize.minimumTarget}
                layout={person ? "row" : "stack"}
                onPress={() => onChoose(option.id)}
              >
                {"color" in option ? <PersonMark person={option} /> : null}
              </ChoiceTile>
            ))}
          </View>
        ))}
      </View>
      <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
        <Button label={person ? tr.addBox.addPerson : tr.addBox.addLocation} icon={person ? UserPlus : MapPinPlus} variant="ghost" size="sm" onPress={() => void add()} />
      </View>
    </>
  );
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

/** One line of an edit, in a box's history and a household's: the field, what it was and what it became, each as the page shows it. */
function changeLine(field: string, [before, after]: [unknown, unknown], unit: string, people: readonly Named[], places: readonly Named[], writer: Writer): string | null {
  if (field === "checkOf") return after == null ? tr.box.checkDone : tr.box.checkAsked(writer(String(after)) ?? tr.sharing.unnamed);
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

export function changeLines(changes: BoxChange["changes"], unit: string, people: readonly Named[], places: readonly Named[], writer: Writer): string {
  return Object.entries(changes)
    .map(([field, pair]) => changeLine(field, pair, unit, people, places, writer))
    .filter((line) => line != null)
    .join("\n");
}
