/**
 * Whose a box is, or where it is kept: the cabinet's names as tiles, with
 * "Atanmamış" first, and a way to add a name without leaving the screen. A
 * person's tile carries their mark, so their boxes are told apart at a glance.
 */

import { Image, Text, View } from "react-native";
import MapPinPlus from "lucide-react-native/icons/map-pin-plus";
import UserPlus from "lucide-react-native/icons/user-plus";

import type { Named, Person } from "../data/cabinet";
import { PERSON_COLORS } from "../db/schema";
import { tr } from "../i18n/tr";
import { Button, ChoiceTile, SectionHeader, rowsOf } from "./components";
import { appError, appPrompt } from "./dialog";
import { radioGroupKeys } from "./keys";
import { circle, controlSize, font, personColors, personMark, spacing, type, useTheme } from "./theme";

/** The colour of a person given none: the one their id falls on, so it is the same on every device. */
export function colorOf(person: Pick<Person, "id" | "color">): (typeof PERSON_COLORS)[number] {
  if (person.color) return person.color;
  const sum = [...person.id].reduce((total, char) => total + char.charCodeAt(0), 0);
  return PERSON_COLORS[sum % PERSON_COLORS.length]!;
}

/** A person's photo, or their initial on their colour. Its name is said by what it stands beside. */
export function PersonMark({ person, size = personMark.size }: { person: Pick<Person, "id" | "name" | "color" | "thumb">; size?: number }) {
  const { palette, scheme } = useTheme();
  const disc = { width: size, height: size, borderRadius: circle(size) };
  if (person.thumb) return <Image source={{ uri: person.thumb }} accessible={false} style={disc} />;
  return (
    <View accessible={false} style={{ ...disc, backgroundColor: personColors[scheme][colorOf(person)], alignItems: "center", justifyContent: "center" }}>
      <Text style={[size > personMark.size ? type.title : type.small, { color: palette.surface, fontFamily: font.semibold }]}>
        {[...person.name.trim()][0]?.toLocaleUpperCase("tr")}
      </Text>
    </View>
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
