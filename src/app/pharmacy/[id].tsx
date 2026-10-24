/**
 * A pharmacy as OpenStreetMap holds it (`docs/TASKS.md` F5.6): its address,
 * phone and hours, a call, the way there and the place on the device's own
 * map, a star, and the place to correct it for everyone: the data is theirs,
 * so a correction goes there, not to Fiala.
 */

import { useEffect } from "react";
import { useLocalSearchParams } from "expo-router";
import Clock from "lucide-react-native/icons/clock";
import MapPin from "lucide-react-native/icons/map-pin";
import Navigation from "lucide-react-native/icons/navigation";
import Pencil from "lucide-react-native/icons/pencil";
import Phone from "lucide-react-native/icons/phone";
import Star from "lucide-react-native/icons/star";

import { formatDay } from "../../domain/boxes";
import { tr } from "../../i18n/tr";
import { hoursInTurkish, pharmaciesById, recentPharmacies, starredPharmacies, type Pharmacy } from "../../services/guide";
import { Body, Card, IconButton, ListRow, Missing, Screen } from "../../ui/components";
import { callLink, correctionLink, directionsLink, mapLink, openLink, pharmacyName, useAnswer, useRemembered } from "../../ui/guide";
import { spacing } from "../../ui/theme";

/** One pharmacy, `undefined` when the list no longer has it. */
async function pharmacyOf(id: string): Promise<Pharmacy | null | undefined> {
  const found = await pharmaciesById([id]);
  return found && found[0];
}

const remembered = (pharmacy: Pharmacy) => ({
  id: pharmacy.id,
  title: pharmacyName(pharmacy),
  subtitle: tr.common.joined(pharmacy.neighbourhood ?? undefined, pharmacy.district ?? undefined, pharmacy.province),
});

export default function PharmacyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const answer = useAnswer(id ?? null, pharmacyOf);
  const starred = useRemembered(starredPharmacies).some((item) => item.id === id);
  const pharmacy = answer.data;

  useEffect(() => {
    if (pharmacy) recentPharmacies.add(remembered(pharmacy));
  }, [pharmacy]);

  if (!pharmacy) {
    return (
      <Screen back="/pharmacies" title={tr.pharmacies.title}>
        <Missing query={answer} text={tr.pharmacies.notFound} />
      </Screen>
    );
  }

  const place = tr.common.joined(pharmacy.neighbourhood ?? undefined, pharmacy.district ?? undefined, pharmacy.province);
  return (
    <Screen
      back="/pharmacies"
      title={pharmacyName(pharmacy)}
      actions={
        <IconButton
          icon={Star}
          label={tr.pharmacies.star}
          on={starred}
          onPress={() => (starred ? starredPharmacies.remove(pharmacy.id) : starredPharmacies.add(remembered(pharmacy)))}
        />
      }
    >
      <Card rows>
        <ListRow icon={MapPin} title={pharmacy.address ?? place} subtitle={pharmacy.address ? place : tr.pharmacies.address} />
        {pharmacy.openingHours ? <ListRow icon={Clock} title={hoursInTurkish(pharmacy.openingHours)} subtitle={tr.pharmacies.hours} /> : null}
        {pharmacy.phone ? <ListRow icon={Phone} title={pharmacy.phone} subtitle={tr.pharmacies.call} onPress={() => void openLink(callLink(pharmacy.phone!))} /> : null}
      </Card>
      <Card rows>
        <ListRow icon={Navigation} title={tr.pharmacies.directions} onPress={() => void openLink(directionsLink(pharmacy))} />
        <ListRow icon={MapPin} title={tr.pharmacies.openMap} onPress={() => void openLink(mapLink(pharmacy))} />
        <ListRow icon={Pencil} title={tr.pharmacies.fix} subtitle={tr.pharmacies.fixHint} onPress={() => void openLink(correctionLink(pharmacy))} />
      </Card>
      <Body muted style={{ marginTop: spacing.sm }}>{tr.pharmacies.source(formatDay(pharmacy.seenOn))}</Body>
    </Screen>
  );
}
