/**
 * A medicine as TİTCK's list gives it (`docs/TASKS.md` F5.2, F5.3): its
 * fields split from the listed name, its substance and what its ATC code's
 * first letter means, its holder, whether it is in the cabinet and which
 * boxes, the same substance at home, the list's other strengths and forms of
 * the name and other names of the substance, a way into the cabinet, and the
 * official leaflet on TİTCK's own page: the leaflet is linked, never copied
 * (`docs/ARCHITECTURE.md` "The guide's data").
 */

import { useEffect } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import FileText from "lucide-react-native/icons/file-text";
import Flag from "lucide-react-native/icons/flag";
import Package from "lucide-react-native/icons/package";
import Plus from "lucide-react-native/icons/plus";
import Star from "lucide-react-native/icons/star";

import { useCabinet } from "../../data/hooks";
import { catalogueFields, foldName, formatDay, printedGtin } from "../../domain/boxes";
import { tr } from "../../i18n/tr";
import { catalogueEntry, catalogueRelated, recentMedicines, starredMedicines, type CatalogueEntry } from "../../services/guide";
import { EntryRow } from "../../ui/catalogue";
import { Body, Button, Card, IconButton, ListRow, Missing, Notice, ReadFailed, Screen, SectionHeader } from "../../ui/components";
import { openLink, useAnswer, useRemembered } from "../../ui/guide";
import { spacing } from "../../ui/theme";

const LEAFLETS = "https://www.titck.gov.tr/kubkt";

const firstWord = (name: string) => foldName(name).split(" ")[0];

/** What a remembered row keeps of an entry. */
const remembered = (entry: CatalogueEntry) => {
  const { name, strength, form } = catalogueFields(entry.name);
  return { id: entry.id, title: tr.common.joined(name, strength ?? undefined), subtitle: form ?? undefined };
};

export default function MedicineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const answer = useAnswer(id ?? null, catalogueEntry);
  const starred = useRemembered(starredMedicines).some((item) => item.id === id);
  const entry = answer.data;

  useEffect(() => {
    if (entry) recentMedicines.add(remembered(entry));
  }, [entry]);

  if (!entry) {
    return (
      <Screen back="/guide" title={tr.medicine.title}>
        <Missing query={answer} text={tr.medicine.notFound} />
      </Screen>
    );
  }

  const { name, strength, form, pack } = catalogueFields(entry.name);
  const group = entry.atc ? tr.medicine.atcGroups[entry.atc[0]!.toUpperCase()] : undefined;
  const field = (title: string, value: string | null | undefined) => <ListRow title={value ?? tr.medicine.unknown} subtitle={title} />;

  return (
    <Screen
      back="/guide"
      title={name}
      actions={
        <IconButton
          icon={Star}
          label={tr.medicine.star}
          on={starred}
          onPress={() => (starred ? starredMedicines.remove(entry.id) : starredMedicines.add(remembered(entry)))}
        />
      }
    >
      {entry.suspended ? <Notice tone="error" text={tr.medicine.suspended} /> : null}
      <Card rows>
        {field(tr.medicine.strength, strength)}
        {field(tr.medicine.form, form)}
        {field(tr.medicine.pack, pack)}
        {field(tr.medicine.substance, entry.activeSubstance)}
        <ListRow title={tr.common.joined(entry.atc ?? tr.medicine.unknown, group)} subtitle={tr.medicine.atc} />
        {field(tr.medicine.holder, entry.holder)}
        {entry.gtin ? field(tr.medicine.barcode, printedGtin(entry.gtin)) : null}
      </Card>
      {group ? <Body muted style={{ marginBottom: spacing.md }}>{tr.medicine.atcExplain}</Body> : null}

      <Card rows>
        <ListRow icon={FileText} title={tr.medicine.leaflet} subtitle={tr.medicine.leafletHint} onPress={() => void openLink(`${LEAFLETS}?search=${encodeURIComponent(name)}`)} />
      </Card>
      <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
        <Button label={tr.medicine.addToCabinet} icon={Plus} onPress={() => router.push({ pathname: "/add-box", params: { listed: entry.id } })} />
      </View>

      <AtHome entry={entry} />
      <Related entry={entry} />

      <Body muted style={{ marginTop: spacing.md }}>{tr.catalogue.source(formatDay(entry.listedOn))}</Body>
      <Body muted>{tr.medicine.informational}</Body>
      <View style={{ alignItems: "flex-start", marginTop: spacing.md }}>
        <Button
          label={tr.medicine.report}
          icon={Flag}
          variant="ghost"
          size="sm"
          onPress={() => router.push({ pathname: "/feedback", params: { category: "data", message: tr.medicine.reportMessage(entry.name) } })}
        />
      </View>
    </Screen>
  );
}

/** The cabinet's medicines with this barcode, and those with its substance. */
function AtHome({ entry }: { entry: CatalogueEntry }) {
  const router = useRouter();
  const cabinet = useCabinet().data;
  const substance = entry.activeSubstance && foldName(entry.activeSubstance);
  const same = entry.gtin ? cabinet.filter((product) => product.gtin === entry.gtin) : [];
  const alike = substance ? cabinet.filter((product) => !same.includes(product) && product.activeSubstance && foldName(product.activeSubstance) === substance) : [];
  const row = (product: (typeof cabinet)[number], title: string) => (
    <ListRow key={product.id} icon={Package} title={title} subtitle={tr.cabinet.boxes(product.boxes.length)} chevron onPress={() => router.push({ pathname: "/product/[id]", params: { id: product.id } })} />
  );
  return (
    <>
      <SectionHeader>{tr.medicine.homeSection}</SectionHeader>
      <Card rows>
        {same.length === 0 ? <ListRow title={tr.medicine.notHome} /> : null}
        {same.map((product) => row(product, product.name))}
      </Card>
      {alike.length > 0 ? (
        <>
          <SectionHeader>{tr.medicine.sameSubstanceHome}</SectionHeader>
          <Card rows>{alike.map((product) => row(product, tr.common.joined(product.name, product.strength ?? undefined)))}</Card>
        </>
      ) : null}
    </>
  );
}

/** The list's other strengths and forms of the name, then other names of the substance. */
function Related({ entry }: { entry: CatalogueEntry }) {
  const router = useRouter();
  const related = useAnswer(entry.id, catalogueRelated);
  if (related.status === "error") return <ReadFailed queries={[related]} />;
  const brand = firstWord(entry.name);
  const open = (other: CatalogueEntry) => router.push({ pathname: "/medicine/[id]", params: { id: other.id } });
  const relatives = (title: string, entries: readonly CatalogueEntry[]) =>
    entries.length > 0 ? (
      <>
        <SectionHeader>{title}</SectionHeader>
        <Card rows>
          {entries.map((other) => (
            <EntryRow key={other.id} entry={other} onPick={open} />
          ))}
        </Card>
      </>
    ) : null;
  return (
    <>
      {relatives(tr.medicine.otherStrengths, related.data?.filter((each) => firstWord(each.name) === brand) ?? [])}
      {relatives(tr.medicine.sameSubstance, related.data?.filter((each) => firstWord(each.name) !== brand) ?? [])}
    </>
  );
}
