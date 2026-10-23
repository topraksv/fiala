/**
 * Profil ve Varsayılanlar (`docs/TASKS.md` F1.28): which of the cabinet's
 * people the account is — their name greets it in Ayarlar, their photo is its
 * picture — and whose and where a new box is until the form says otherwise.
 * Kept in the account's settings, so every device has them. They are the
 * names of the cabinet a new box goes to unless the form says otherwise: the
 * household open when they may write in it, else the person's own, each
 * cabinet keeping its own choices (F2.4).
 */

import { addNamed } from "../data/cabinet";
import { useHouseholds, useLocations, usePeople, useSettings } from "../data/hooks";
import { chooseProfile, profileChoice, type ProfileChoice } from "../data/settings";
import { tr } from "../i18n/tr";
import { Body, Screen } from "../ui/components";
import { appError } from "../ui/dialog";
import { NamedChoices } from "../ui/named-choices";
import { spacing } from "../ui/theme";

export default function Profile() {
  const { me, open, writes } = useHouseholds();
  const cabinetId = open && writes(open.id) ? open.id : me;
  const settings = useSettings();
  const people = usePeople().data.filter((each) => each.cabinetId === cabinetId);
  const locations = useLocations().data.filter((each) => each.cabinetId === cabinetId);
  if (!cabinetId) return <Screen back="/settings" title={tr.profile.title} width="form" />;
  const choose = (choice: ProfileChoice) => (id: string | null) => void chooseProfile(choice, cabinetId, id).catch(() => appError(tr.errors.saveFailed));
  const add = (table: "people" | "locations", choice: ProfileChoice) => async (name: string) => chooseProfile(choice, cabinetId, await addNamed(table, cabinetId, name));
  return (
    <Screen back="/settings" title={tr.profile.title} width="form">
      <Body muted style={{ marginBottom: spacing.md }}>{tr.profile.hint}</Body>
      <NamedChoices table="people" title={tr.profile.me} named={people} chosen={profileChoice(settings.data, "me", cabinetId, people)} onChoose={choose("me")} onAdd={add("people", "me")} />
      <NamedChoices table="people" title={tr.profile.owner} named={people} chosen={profileChoice(settings.data, "owner", cabinetId, people)} onChoose={choose("owner")} onAdd={add("people", "owner")} />
      <NamedChoices table="locations" title={tr.profile.place} named={locations} chosen={profileChoice(settings.data, "place", cabinetId, locations)} onChoose={choose("place")} onAdd={add("locations", "place")} />
    </Screen>
  );
}
