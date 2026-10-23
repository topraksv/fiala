/**
 * What asks for the person now, atop Durum and the notification centre
 * (`docs/TASKS.md` F2.7, F2.11): sync when it needs them, and households
 * offered to them. Each is a state, not a moment, so the centre's thirty days
 * do not hold it.
 */

import { useRouter } from "expo-router";
import CloudOff from "lucide-react-native/icons/cloud-off";
import HousePlus from "lucide-react-native/icons/house-plus";

import { tr } from "../i18n/tr";
import { useOffers } from "../sync/sharing";
import { useSyncStatus } from "../sync/status";
import { Card, ListRow, SectionHeader } from "./components";
import { useTheme } from "./theme";

export function Attention() {
  return (
    <>
      <SyncSummary />
      <ReceivedOffers />
    </>
  );
}

/**
 * Sync, only when it asks for something (`docs/TASKS.md` F2.7): a
 * failure, offline included, or records the server would not take. While it
 * keeps up it says nothing here; Ayarlar always says how it stands.
 */
function SyncSummary() {
  const router = useRouter();
  const { palette } = useTheme();
  const { state, error } = useSyncStatus();
  if (state !== "error" && state !== "attention") return null;
  const refused = state === "attention";
  return (
    <Card rows>
      <ListRow
        icon={CloudOff}
        iconColor={refused ? palette.warning : palette.error}
        title={tr.sync[state]}
        subtitle={refused ? tr.sync.errQuarantined : (error ?? tr.sync.errGeneric)}
        chevron
        onPress={() => router.push(refused ? "/sync-issues" : "/settings")}
      />
    </Card>
  );
}

/** Households offered in the app, as the last sync found them; each opens its answer. */
function ReceivedOffers() {
  const router = useRouter();
  const offers = useOffers((s) => s.received);
  if (offers.length === 0) return null;
  return (
    <>
      <SectionHeader flush>{tr.sharing.offers}</SectionHeader>
      <Card rows>
        {offers.map((offer) => (
          <ListRow
            key={offer.cabinetId}
            icon={HousePlus}
            title={offer.cabinetName}
            subtitle={tr.sharing.invitedTo(offer.fromName, offer.cabinetName)}
            chevron
            onPress={() => router.push({ pathname: "/invite", params: { offer: offer.cabinetId } })}
          />
        ))}
      </Card>
    </>
  );
}
