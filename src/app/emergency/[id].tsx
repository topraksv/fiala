/**
 * One person's emergency card (`docs/TASKS.md` F7.7): what they must not be
 * given, what they live with and what they take now, large enough to hold up
 * to someone, and sent as plain text. Only what was typed is shown: nothing
 * is inferred from a medicine, so an empty field says it was not entered
 * rather than that there is none.
 */

import { Fragment } from "react";
import { useLocalSearchParams } from "expo-router";
import Share2 from "lucide-react-native/icons/share-2";

import { useDosePlans, usePeople } from "../../data/hooks";
import { localDay } from "../../domain/boxes";
import { runsOn, timesOf } from "../../domain/doses";
import { tr } from "../../i18n/tr";
import { shareText } from "../../services/share";
import { Body, Button, Card, Missing, Screen, SectionHeader } from "../../ui/components";
import { appError } from "../../ui/dialog";
import { doseAmount } from "../../ui/doses";
import { spacing, type } from "../../ui/theme";
import { showNotice } from "../../ui/undo";

export default function EmergencyCardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const people = usePeople();
  const plans = useDosePlans().data;
  const person = people.data.find((each) => each.id === id);
  const back = `/person/${id}` as const;

  if (!person) {
    return (
      <Screen back={back} title={tr.emergency.title}>
        <Missing query={people} text={tr.person.notFound} />
      </Screen>
    );
  }

  const today = localDay();
  const medicines = plans
    .filter((plan) => plan.personId === person.id && runsOn(plan, today))
    .map((plan) => tr.emergency.dose(tr.common.joined(plan.name, plan.strength ?? undefined), doseAmount(plan), timesOf(plan.times).join(", ")));
  const sections: [string, string][] = [
    [tr.person.allergies, person.allergies ?? tr.person.none],
    [tr.person.conditions, person.conditions ?? tr.person.none],
    [tr.emergency.medicines, medicines.length > 0 ? medicines.join("\n") : tr.emergency.noMedicines],
  ];

  const share = async () => {
    try {
      if ((await shareText(tr.emergency.text(person.name, sections))) === "clipboard") showNotice(tr.emergency.copied);
    } catch {
      await appError(tr.errors.shareFailed);
    }
  };

  return (
    <Screen back={back} title={tr.emergency.title}>
      <Body style={{ ...type.title, marginBottom: spacing.md }}>{person.name}</Body>
      {sections.map(([title, body]) => (
        <Fragment key={title}>
          <SectionHeader>{title}</SectionHeader>
          <Card>
            <Body style={type.heading}>{body}</Body>
          </Card>
        </Fragment>
      ))}
      <Button label={tr.emergency.share} icon={Share2} onPress={() => void share()} />
    </Screen>
  );
}

