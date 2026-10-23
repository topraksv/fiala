/**
 * Profil ve Varsayılanlar (`docs/TASKS.md` F1.28): which of the cabinet's
 * people the account is — their name greets it in Ayarlar, their photo is its
 * picture — and whose and where a new box is until the form says otherwise.
 * Kept in the account's settings, so every device has them.
 */

import { addNamed } from "../data/cabinet";
import { useLocations, usePeople, useSettings } from "../data/hooks";
import { chooseProfile, profileChoice, type ProfileChoice } from "../data/settings";
import { useSession } from "../auth/session";
import { tr } from "../i18n/tr";
import { Body, Screen } from "../ui/components";
import { appError } from "../ui/dialog";
import { NamedChoices } from "../ui/named-choices";
import { spacing } from "../ui/theme";

export default function Profile() {
  const cabinetId = useSession((s) => s.userId);
  const settings = useSettings();
  const people = usePeople();
  const locations = useLocations();
  const choose = (choice: ProfileChoice) => (id: string | null) => void chooseProfile(choice, id).catch(() => appError(tr.errors.saveFailed));
  const add = (table: "people" | "locations", choice: ProfileChoice) => async (name: string) => {
    if (!cabinetId) return;
    await chooseProfile(choice, await addNamed(table, cabinetId, name));
  };
  return (
    <Screen back="/settings" title={tr.profile.title} width="form">
      <Body muted style={{ marginBottom: spacing.md }}>{tr.profile.hint}</Body>
      <NamedChoices table="people" title={tr.profile.me} named={people.data} chosen={profileChoice(settings.data, "me", people.data)} onChoose={choose("me")} onAdd={add("people", "me")} />
      <NamedChoices table="people" title={tr.profile.owner} named={people.data} chosen={profileChoice(settings.data, "owner", people.data)} onChoose={choose("owner")} onAdd={add("people", "owner")} />
      <NamedChoices table="locations" title={tr.profile.place} named={locations.data} chosen={profileChoice(settings.data, "place", locations.data)} onChoose={choose("place")} onAdd={add("locations", "place")} />
    </Screen>
  );
}
