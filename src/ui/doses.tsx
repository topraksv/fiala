/**
 * A dose plan as every list draws it (`docs/TASKS.md` F3.7, F3.9): the
 * calendar's, and a product's own, which adds one for that medicine.
 */

import { View } from "react-native";
import { useRouter } from "expo-router";
import Pill from "lucide-react-native/icons/pill";
import Plus from "lucide-react-native/icons/plus";

import type { CabinetDosePlan } from "../data/doses";
import { useDosePlans, usePeople } from "../data/hooks";
import { formatAmount, formatDay, localDay } from "../domain/boxes";
import { EVERY_DAY, timesOf } from "../domain/doses";
import { tr } from "../i18n/tr";
import { Button, Card, ListRow, SectionHeader } from "./components";
import { spacing } from "./theme";

/** A plan's days as a reader says them: every day, or the days by name. */
export const daysOf = (weekdays: number) => (weekdays === EVERY_DAY ? tr.doses.everyDay : tr.common.joined(...tr.doses.weekdays.filter((_, at) => (weekdays & (1 << at)) !== 0)));

/** How much a dose is, in its box's unit while it names a live one. */
export const doseAmount = (plan: Pick<CabinetDosePlan, "amountMilli" | "unit">) => tr.doses.amount(formatAmount(plan.amountMilli), plan.unit ? tr.units[plan.unit] : null);

export function PlanRows({ plans }: { plans: readonly CabinetDosePlan[] }) {
  const router = useRouter();
  const people = usePeople().data;
  const today = localDay();
  return (
    <Card rows>
      {plans.map((plan) => (
        <ListRow
          key={plan.id}
          icon={Pill}
          title={tr.common.joined(plan.name, plan.strength ?? undefined)}
          subtitle={tr.common.joined(
            doseAmount(plan),
            timesOf(plan.times).join(", "),
            daysOf(plan.weekdays),
            people.find((person) => person.id === plan.personId)?.name,
            plan.endsOn && plan.endsOn < today ? tr.doses.ended : plan.endsOn ? formatDay(plan.endsOn) : undefined,
            plan.paused ? tr.doses.paused : undefined,
          )}
          chevron
          onPress={() => router.push({ pathname: "/dose-plan", params: { id: plan.id } })}
        />
      ))}
    </Card>
  );
}

/** A product's plans, and for whoever may change it one more for that medicine. */
export function ProductPlans({ productId, editable }: { productId: string; editable: boolean }) {
  const router = useRouter();
  const plans = useDosePlans().data.filter((plan) => plan.productId === productId);
  if (plans.length === 0 && !editable) return null;
  return (
    <>
      <SectionHeader>{tr.doses.plansSection}</SectionHeader>
      {plans.length > 0 ? <PlanRows plans={plans} /> : null}
      {editable ? (
        <View style={{ alignItems: "flex-start", marginBottom: spacing.lg }}>
          <Button label={tr.doses.add} icon={Plus} variant="ghost" size="sm" onPress={() => router.push({ pathname: "/dose-plan", params: { product: productId } })} />
        </View>
      ) : null}
    </>
  );
}
