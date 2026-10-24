/**
 * Two medicines of TİTCK's list side by side (`docs/TASKS.md` F5.3): the
 * fields its page shows, each once when the two agree and in two columns when
 * they differ. Opened from a medicine's page; the second is chosen here by
 * searching, as the add screen does.
 */

import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import ArrowLeftRight from "lucide-react-native/icons/arrow-left-right";

import { catalogueFields, formatDay } from "../../domain/boxes";
import { tr } from "../../i18n/tr";
import { catalogueEntry, type CatalogueEntry } from "../../services/guide";
import { CatalogueSearch, EntryRow } from "../../ui/catalogue";
import { Body, Button, Card, Missing, Screen } from "../../ui/components";
import { useAnswer } from "../../ui/guide";
import { spacing, type, useTheme } from "../../ui/theme";

/** The fields compared, in the medicine page's order; what the list leaves out reads as such. */
function fieldsOf(entry: CatalogueEntry): [string, string][] {
  const { strength, form, pack } = catalogueFields(entry.name);
  const group = entry.atc ? tr.medicine.atcGroups[entry.atc[0]!.toUpperCase()] : undefined;
  const known = (value: string | null | undefined) => value ?? tr.medicine.unknown;
  return [
    [tr.medicine.strength, known(strength)],
    [tr.medicine.form, known(form)],
    [tr.medicine.pack, known(pack)],
    [tr.medicine.substance, known(entry.activeSubstance)],
    [tr.medicine.atc, tr.common.joined(known(entry.atc), group)],
    [tr.medicine.holder, known(entry.holder)],
    [tr.compare.licence, entry.suspended ? tr.catalogue.suspended : tr.compare.licensed],
  ];
}

export default function CompareScreen() {
  const { a, b } = useLocalSearchParams<{ a: string; b?: string }>();
  const router = useRouter();
  const first = useAnswer(a ?? null, catalogueEntry);
  const second = useAnswer(b ?? null, catalogueEntry);
  const open = (entry: CatalogueEntry) => router.push({ pathname: "/medicine/[id]", params: { id: entry.id } });

  if (!first.data) {
    return (
      <Screen back="/guide" title={tr.compare.title}>
        <Missing query={first} text={tr.medicine.notFound} />
      </Screen>
    );
  }
  const left = first.data;

  return (
    <Screen back={{ pathname: "/medicine/[id]", params: { id: left.id } }} title={tr.compare.title}>
      <EntryRow entry={left} onPick={open} />
      {!b ? (
        <>
          <Body style={{ marginVertical: spacing.sm }}>{tr.compare.pick}</Body>
          <CatalogueSearch autoFocus onPick={(other) => router.setParams({ b: other.id })} />
        </>
      ) : !second.data ? (
        <Missing query={second} text={tr.medicine.notFound} />
      ) : (
        <Compared left={left} right={second.data} onOpen={open} onChange={() => router.setParams({ b: "" })} />
      )}
    </Screen>
  );
}

function Compared({ left, right, onOpen, onChange }: { left: CatalogueEntry; right: CatalogueEntry; onOpen: (entry: CatalogueEntry) => void; onChange: () => void }) {
  const { palette } = useTheme();
  const theirs = fieldsOf(right);
  const value = (text: string) => <Text style={[type.body, { flex: 1, color: palette.text }]}>{text}</Text>;
  return (
    <>
      <EntryRow entry={right} onPick={onOpen} />
      <View style={{ alignItems: "flex-start", marginVertical: spacing.sm }}>
        <Button label={tr.compare.change} icon={ArrowLeftRight} variant="ghost" size="sm" onPress={onChange} />
      </View>
      <Card>
        {fieldsOf(left).map(([label, mine], index) => {
          const other = theirs[index]![1];
          const same = mine === other;
          return (
            <View
              key={label}
              accessible
              accessibilityLabel={same ? tr.compare.sameSaid(label, mine) : tr.compare.differSaid(label, mine, other)}
              style={{ marginTop: index === 0 ? 0 : spacing.md }}
            >
              <Text style={[type.label, { color: palette.textSecondary, marginBottom: spacing.xs }]}>{same ? tr.compare.same(label) : label}</Text>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                {value(mine)}
                {same ? null : value(other)}
              </View>
            </View>
          );
        })}
      </Card>
      <Body muted style={{ marginTop: spacing.md }}>{tr.catalogue.source(formatDay(left.listedOn))}</Body>
      <Body muted>{tr.medicine.informational}</Body>
    </>
  );
}
