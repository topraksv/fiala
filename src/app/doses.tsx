/**
 * Doz Takvimi (`docs/TASKS.md` F3.8, F3.9): a week at a time, the chosen
 * day's doses of the person's own cabinet and the household open, each by
 * time with what became of it, answered here; one person's alone where the
 * plans name several. A carer who only reads the household sees whether a
 * dose was taken, and by whom, without answering it. The plans follow.
 */

import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Ellipsis from "lucide-react-native/icons/ellipsis";
import Pill from "lucide-react-native/icons/pill";
import Plus from "lucide-react-native/icons/plus";

import type { CabinetDosePlan, ReadDoseAnswer } from "../data/doses";
import { useDoseAnswers, useDosePlans, useHouseholds, usePeople } from "../data/hooks";
import type { DoseStatus } from "../db/schema";
import { formatDay, localDay } from "../domain/boxes";
import { dosesOfDay, shiftDay, weekdayOf, type DayDose } from "../domain/doses";
import { tr } from "../i18n/tr";
import { Body, Button, Card, ChoiceTile, EmptyState, IconButton, ListRow, ReadFailed, rowsOf, Screen, SectionHeader, useTileColumns } from "../ui/components";
import { answerWithUndo, doseAmount, PlanRows } from "../ui/doses";
import { Tiles } from "../ui/documents";
import { radioGroupKeys } from "../ui/keys";
import { WEEKDAY_TILE_WIDTH } from "../ui/responsive";
import { useWriter } from "../ui/named-choices";
import { controlSize, spacing, useTheme } from "../ui/theme";

/** The two a dose is mostly given; putting it off and saying it was missed wait behind "…" (F7.14). */
const ANSWERS: readonly DoseStatus[] = ["taken", "skipped"];
const MORE_ANSWERS: readonly DoseStatus[] = ["snoozed", "missed"];

/** The Monday of a day's week. */
/** Days by their place in the week, Monday first. */
const WEEK = tr.doses.weekdays.map((_, at) => at);
const mondayOf = (day: string) => shiftDay(day, -Math.log2(weekdayOf(day)));

export default function Doses() {
  // A week that will not fit one row splits four and three, never six and one.
  const weekColumns = useTileColumns(7, WEEKDAY_TILE_WIDTH) < 7 ? 4 : 7;
  const router = useRouter();
  const today = localDay();
  const [day, setDay] = useState(today);
  const [whose, setWhose] = useState<string | null>(null);
  const monday = mondayOf(day);
  const plans = useDosePlans();
  const answers = useDoseAnswers(monday, shiftDay(monday, 6));
  const { shows, writes } = useHouseholds();
  const people = usePeople().data;
  const shown = plans.data.filter((plan) => shows(plan.cabinetId));
  const answered = answers.data.filter((answer) => shows(answer.cabinetId));
  // Only the people a plan or an answer names: a filter that finds nothing is not offered.
  const named = people.filter((person) => shown.some((plan) => plan.personId === person.id) || answered.some((answer) => answer.personId === person.id));
  const person = named.some((each) => each.id === whose) ? whose : null;
  const add = () => router.push("/dose-plan");

  if (plans.status === "error" || answers.status === "error") {
    return (
      <Screen back="/" title={tr.doses.title}>
        <ReadFailed queries={[plans, answers]} />
      </Screen>
    );
  }
  if (plans.status === "loading") return <Screen back="/" title={tr.doses.title} />;
  if (shown.length === 0 && answered.length === 0) {
    return (
      <Screen back="/" title={tr.doses.title}>
        <EmptyState icon={CalendarClock} title={tr.doses.emptyTitle} hint={tr.doses.emptyHint} action={<Button label={tr.doses.add} icon={Plus} onPress={add} />} />
      </Screen>
    );
  }

  const theirs = <T extends { personId: string | null }>(rows: readonly T[]) => rows.filter((row) => person == null || row.personId === person);
  const doses = dosesOfDay(theirs(shown), theirs(answered), day, new Date());
  return (
    <Screen back="/" title={tr.doses.title} actions={<IconButton icon={Plus} label={tr.doses.add} onPress={add} />}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, marginBottom: spacing.sm }}>
        <IconButton icon={ChevronLeft} label={tr.doses.previousWeek} onPress={() => setDay(shiftDay(day, -7))} />
        <Body style={{ flex: 1, textAlign: "center" }}>{tr.common.joined(formatDay(monday), formatDay(shiftDay(monday, 6)))}</Body>
        <IconButton icon={ChevronRight} label={tr.doses.nextWeek} onPress={() => setDay(shiftDay(day, 7))} />
      </View>
      <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.doses.title} style={{ gap: spacing.xs, marginBottom: spacing.sm }}>
        {rowsOf(WEEK, weekColumns).map((row, line) => (
          <View key={line} style={{ flexDirection: "row", gap: spacing.xs }}>
            {row.map((at) => {
              const each = shiftDay(monday, at);
              const short = tr.doses.weekdays[at];
              return (
                <ChoiceTile
                  key={each}
                  label={`${short}\n${Number(each.slice(8))}`}
                  accessibilityLabel={tr.common.joined(tr.doses.weekdayNames[at], formatDay(each), each === today ? tr.doses.today : undefined)}
                  selected={each === day}
                  minHeight={controlSize.minimumTarget}
                  onPress={() => setDay(each)}
                />
              );
            })}
            {/* An empty cell keeps the short row's days as wide as the long row's. */}
            {Array.from({ length: weekColumns - row.length }, (_, cell) => (
              <View key={cell} style={{ flexGrow: 1, flexBasis: 0 }} />
            ))}
          </View>
        ))}
      </View>
      {day !== today ? (
        <View style={{ alignItems: "flex-start", marginBottom: spacing.sm }}>
          <Button label={tr.doses.today} variant="ghost" size="sm" onPress={() => setDay(today)} />
        </View>
      ) : null}
      {named.length > 0 ? <Tiles label={tr.doses.whoseSection} options={[{ id: null, name: tr.cabinet.everyone.people }, ...named]} chosen={person} onChoose={setWhose} /> : null}

      <SectionHeader>{day === today ? tr.doses.today : formatDay(day)}</SectionHeader>
      {doses.length === 0 ? <Body muted>{tr.doses.noDoses}</Body> : null}
      {doses.map((dose) => (
        <DoseCard
          key={`${dose.planId} ${dose.dueTime}`}
          dose={dose}
          plan={shown.find((each) => each.id === dose.planId)}
          said={dose.answer ? answered.find((each) => each.planId === dose.planId && each.dueOn === dose.dueOn && each.dueTime === dose.dueTime) : undefined}
          answerable={(cabinetId) => writes(cabinetId) && dose.dueOn <= today}
          onAnswer={(status) => void answerWithUndo(dose, status, writes)}
        />
      ))}

      {shown.length > 0 ? (
        <>
          <SectionHeader>{tr.doses.plansSection}</SectionHeader>
          <PlanRows plans={theirs(shown)} />
        </>
      ) : null}
    </Screen>
  );
}

/** What a dose's row says under its time and name: how much, for whom, what became of it, until when, by whom. */
function doseSubtitle(dose: DayDose, plan: CabinetDosePlan | undefined, person: string | undefined, by: string | undefined) {
  const until = dose.answer?.snoozedUntil;
  return tr.common.joined(
    plan ? doseAmount(plan) : undefined,
    person,
    tr.doses.states[dose.state],
    until ? tr.doses.until(new Date(until).toTimeString().slice(0, 5)) : undefined,
    by ? tr.doses.by(by) : undefined,
  );
}

/**
 * One dose of the day, answered here by whoever may write its plan's cabinet
 * once it has come; a deleted plan's answer stays as it was.
 */
function DoseCard({ dose, plan, said, answerable, onAnswer }: { dose: DayDose; plan: CabinetDosePlan | undefined; said: ReadDoseAnswer | undefined; answerable: (cabinetId: string) => boolean; onAnswer: (status: DoseStatus | null) => void }) {
  const { palette } = useTheme();
  const { open } = useHouseholds();
  const writer = useWriter(open?.id);
  const people = usePeople().data;
  const person = people.find((each) => each.id === (plan?.personId ?? said?.personId))?.name;
  const by = said?.answeredBy ? writer(said.answeredBy) : undefined;
  const late = dose.state === "missed" || dose.state === "unanswered";
  return (
    <Card rows>
      <ListRow
        icon={Pill}
        iconColor={dose.state === "due" ? palette.warning : late ? palette.error : undefined}
        title={`${dose.dueTime} · ${plan?.name ?? said?.name ?? ""}`}
        subtitle={doseSubtitle(dose, plan, person, by)}
      />
      {plan && answerable(plan.cabinetId) ? <AnswerButtons state={dose.state} onAnswer={onAnswer} /> : null}
    </Card>
  );
}

function AnswerButtons({ state, onAnswer }: { state: DayDose["state"]; onAnswer: (status: DoseStatus | null) => void }) {
  // Put off, a dose is still to be answered.
  const final = state === "taken" || state === "skipped" || state === "missed";
  const [more, setMore] = useState(false);
  const answer = (status: DoseStatus) => (
    <Button key={status} label={tr.doses.answers[status]} variant={status === "taken" ? "primary" : "secondary"} size="sm" onPress={() => onAnswer(status)} />
  );
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.xs, paddingBottom: spacing.sm }}>
      {final ? (
        <Button label={tr.doses.clear} variant="ghost" size="sm" onPress={() => onAnswer(null)} />
      ) : (
        <>
          {ANSWERS.map(answer)}
          <IconButton icon={Ellipsis} label={tr.doses.moreAnswers} on={more} onPress={() => setMore(!more)} />
          {more ? MORE_ANSWERS.filter((status) => status !== state).map(answer) : null}
        </>
      )}
    </View>
  );
}
