import { useRouter } from "expo-router";
import ExternalLink from "lucide-react-native/icons/external-link";
import MapPin from "lucide-react-native/icons/map-pin";
import Pill from "lucide-react-native/icons/pill";
import Star from "lucide-react-native/icons/star";

import { tr } from "../../i18n/tr";
import { recentMedicines, recentPharmacies, starredMedicines, starredPharmacies } from "../../services/guide";
import type { Remembered } from "../../services/kv";
import { CatalogueSearch } from "../../ui/catalogue";
import { Body, Card, ListRow, Screen, SectionHeader } from "../../ui/components";
import { openLink, useRemembered } from "../../ui/guide";
import { spacing } from "../../ui/theme";

/** TİTCK's own duty-pharmacy query on e-Devlet (F5.7 waits for a source the app may keep). */
const ON_DUTY = "https://www.turkiye.gov.tr/saglik-titck-nobetci-eczane-sorgulama";

/**
 * Rehber (`docs/TASKS.md` F5.1): the medicine list searched by name,
 * substance, holder or barcode, what was opened lately and what was starred,
 * and the pharmacies. What this device remembers stays on it.
 */
export default function Guide() {
  const router = useRouter();
  const recent = useRemembered(recentMedicines);
  const recentPlaces = useRemembered(recentPharmacies);
  const medicines = useRemembered(starredMedicines);
  const pharmacies = useRemembered(starredPharmacies);
  const medicine = (item: Remembered) => router.push({ pathname: "/medicine/[id]", params: { id: item.id } });
  const pharmacy = (item: Remembered) => router.push({ pathname: "/pharmacy/[id]", params: { id: item.id } });
  const rows = (items: readonly Remembered[], icon: typeof Pill, open: (item: Remembered) => void) =>
    items.map((item) => <ListRow key={item.id} icon={icon} title={item.title} subtitle={item.subtitle} chevron onPress={() => open(item)} />);

  return (
    <Screen title={tr.tabs.guide}>
      <SectionHeader flush>{tr.guide.medicinesSection}</SectionHeader>
      <Body muted style={{ marginBottom: spacing.sm }}>{tr.guide.searchHint}</Body>
      <CatalogueSearch onPick={(entry) => medicine({ id: entry.id, title: entry.name })} none={tr.guide.searchNone} unreachable={tr.guide.searchUnreachable} />

      {medicines.length + pharmacies.length > 0 ? (
        <>
          <SectionHeader>{tr.guide.starredSection}</SectionHeader>
          <Card rows>
            {rows(medicines, Star, medicine)}
            {rows(pharmacies, Star, pharmacy)}
          </Card>
        </>
      ) : null}

      {recent.length + recentPlaces.length > 0 ? (
        <>
          <SectionHeader>{tr.guide.recentSection}</SectionHeader>
          <Card rows>
            {rows(recent, Pill, medicine)}
            {rows(recentPlaces, MapPin, pharmacy)}
          </Card>
        </>
      ) : null}

      <SectionHeader>{tr.guide.pharmaciesSection}</SectionHeader>
      <Card rows>
        <ListRow icon={MapPin} title={tr.guide.pharmacies} subtitle={tr.guide.pharmaciesHint} chevron onPress={() => router.push("/pharmacies")} />
        <ListRow icon={ExternalLink} title={tr.guide.onDuty} subtitle={tr.guide.onDutyHint} onPress={() => void openLink(ON_DUTY)} />
      </Card>
    </Screen>
  );
}
