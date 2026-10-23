/**
 * A dose plan (`docs/TASKS.md` F3.7, F3.10): a medicine, the box its doses
 * come out of, how much, at what times on which days, from when to when, for
 * whom and how it is taken. With `id` the plan's own page: changed, paused or
 * deleted by whoever may change its cabinet, and for everyone the switch that
 * says whether this phone rings for it. From a product's page or a box's the
 * medicine is chosen already.
 */

import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Pause from "lucide-react-native/icons/pause";
import Pill from "lucide-react-native/icons/pill";
import Play from "lucide-react-native/icons/play";
import Plus from "lucide-react-native/icons/plus";
import Save from "lucide-react-native/icons/save";
import Trash from "lucide-react-native/icons/trash";
import X from "lucide-react-native/icons/x";

import { addNamed, type CabinetBox, type CabinetProduct } from "../data/cabinet";
import { addDosePlan, deleteDosePlans, editDosePlan, type CabinetDosePlan } from "../data/doses";
import { useCabinet, useDosePlans, useHouseholds, usePeople, useSettings } from "../data/hooks";
import { giveHealthConsent, hasHealthConsent } from "../data/settings";
import { undoRows } from "../db/mutations";
import { formatAmount, formatDay, localDay, parseAmount, parseDay } from "../domain/boxes";
import { EVERY_DAY, isTime, TIMES_MAX, timesOf } from "../domain/doses";
import { tr } from "../i18n/tr";
import { readDoseRinging, ringsHere, saveDoseRinging } from "../services/reminder-preferences";
import { Body, Button, Card, IconButton, ListRow, Notice, Screen, SectionHeader, TextField, ToggleRow } from "../ui/components";
import { appConfirm, appError } from "../ui/dialog";
import { useDirtyExitGuard } from "../ui/dirty-exit";
import { daysOf, doseAmount } from "../ui/doses";
import { NamedChoices, ViewOnly } from "../ui/named-choices";
import { navigateBack } from "../ui/navigation";
import { spacing } from "../ui/theme";
import { showNotice, showUndo } from "../ui/undo";

const WEEKDAYS = tr.doses.weekdays.map((_, at) => 1 << at);

/** `8:30` and `08.30` are 08:30: a phone's keypad offers the one or the other. */
function typedTime(text: string): string | null {
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(text.trim());
  const time = match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : "";
  return isTime(time) ? time : null;
}

export default function DosePlanScreen() {
  const { id, product: productParam, package: packageParam } = useLocalSearchParams<{ id?: string; product?: string; package?: string }>();
  const plans = useDosePlans();
  const cabinet = useCabinet();
  const plan = id ? plans.data.find((each) => each.id === id) : undefined;
  if (id && !plan) {
    return (
      <Screen back="/doses" title={tr.doses.plan}>
        {plans.status === "loading" ? null : <Notice tone="error" text={tr.doses.notFound} />}
      </Screen>
    );
  }
  if (cabinet.status === "loading") return <Screen back="/doses" title={plan ? tr.doses.plan : tr.doses.add} />;
  if (plan) return <PlanPage key={plan.id} plan={plan} products={cabinet.data} />;
  const fromBox = cabinet.data.find((each) => each.boxes.some((box) => box.id === packageParam));
  return <PlanForm key="new" title={tr.doses.add} products={cabinet.data} productId={fromBox?.id ?? productParam ?? null} packageId={packageParam ?? null} />;
}

/** The form's fields as a plan has them, or as a new plan starts. */
function fieldsOf(plan: CabinetDosePlan | undefined) {
  if (!plan) return { amount: "1", times: ["09:00"], weekdays: EVERY_DAY, starts: formatDay(localDay()), ends: "", instructions: "", personId: null as string | null };
  return {
    amount: formatAmount(plan.amountMilli),
    times: timesOf(plan.times),
    weekdays: plan.weekdays,
    starts: formatDay(plan.startsOn),
    ends: plan.endsOn ? formatDay(plan.endsOn) : "",
    instructions: plan.instructions ?? "",
    personId: plan.personId,
  };
}

type PlanFields = ReturnType<typeof fieldsOf>;

const changed = (now: unknown, was: unknown) => JSON.stringify(now) !== JSON.stringify(was);

/** What the fields say, read, and what is wrong with each. */
function readFields(fields: PlanFields) {
  const amountMilli = parseAmount(fields.amount);
  const startsOn = parseDay(fields.starts);
  const ended = fields.ends.trim() !== "";
  const endsOn = ended ? parseDay(fields.ends) : null;
  const errors = {
    amount: amountMilli && amountMilli > 0 ? null : tr.doses.amountInvalid,
    days: fields.weekdays === 0 ? tr.doses.daysMissing : null,
    starts: startsOn ? null : tr.addBox.dayInvalid,
    ends: ended && !endsOn ? tr.addBox.dayInvalid : endsOn && startsOn && endsOn < startsOn ? tr.doses.endsBeforeStart : null,
  };
  return { amountMilli, times: fields.times.map(typedTime), startsOn, endsOn, errors };
}

/** A plan as one who only reads its cabinet sees it. */
function PlanFacts({ plan }: { plan: CabinetDosePlan }) {
  return (
    <Card rows>
      <ListRow title={tr.doses.amountLabel(null)} subtitle={doseAmount(plan)} />
      <ListRow title={tr.doses.timesSection} subtitle={timesOf(plan.times).join(", ")} />
      <ListRow title={tr.doses.daysSection} subtitle={daysOf(plan.weekdays)} />
      <ListRow title={tr.doses.startsOn} subtitle={tr.common.joined(formatDay(plan.startsOn), plan.endsOn ? formatDay(plan.endsOn) : undefined)} />
      {plan.instructions ? <ListRow title={tr.doses.instructions} subtitle={plan.instructions} /> : null}
      {plan.paused ? <ListRow title={tr.doses.paused} /> : null}
    </Card>
  );
}

/** The medicine: named when it was given, else chosen among those the person may plan. */
function MedicinePick(props: { fixed: boolean; fallback?: string; product: CabinetProduct | undefined; offered: readonly CabinetProduct[]; missing: boolean; onPick: (id: string) => void }) {
  return (
    <>
      <SectionHeader>{tr.doses.medicineSection}</SectionHeader>
      <MedicineRows {...props} />
      {props.missing ? <Notice tone="error" text={tr.doses.noMedicine} /> : null}
    </>
  );
}

function MedicineRows({ fixed, fallback, product, offered, onPick }: { fixed: boolean; fallback?: string; product: CabinetProduct | undefined; offered: readonly CabinetProduct[]; onPick: (id: string) => void }) {
  if (fixed) {
    return (
      <Card rows>
        <ListRow icon={Pill} title={product ? tr.common.joined(product.name, product.strength ?? undefined) : (fallback ?? "")} />
      </Card>
    );
  }
  if (offered.length === 0) return <Body muted style={{ marginBottom: spacing.md }}>{tr.doses.noMedicine}</Body>;
  return (
    <Card rows>
      {offered.map((each) => (
        <ListRow key={each.id} icon={Pill} title={tr.common.joined(each.name, each.strength ?? undefined)} selected={each.id === product?.id} onPress={() => onPick(each.id)} />
      ))}
    </Card>
  );
}

/** The box at home the doses come out of, or none. */
function BoxPick({ home, packageId, onPick }: { home: readonly CabinetBox[]; packageId: string | null; onPick: (id: string | null) => void }) {
  return (
    <>
      <SectionHeader>{tr.doses.boxSection}</SectionHeader>
      <Body muted style={{ marginBottom: spacing.sm }}>{tr.doses.boxHint}</Body>
      <Card rows>
        <ListRow title={tr.doses.noBox} selected={packageId == null} onPress={() => onPick(null)} />
        {home.map((each) => (
          <ListRow
            key={each.id}
            title={each.nickname ?? (each.expiresOn ? tr.cabinet.expires(formatDay(each.expiresOn)) : tr.cabinet.noExpiry)}
            subtitle={each.counted ? tr.cabinet.remaining(formatAmount(each.remainingMilli), tr.units[each.unit]) : tr.cabinet.uncounted}
            selected={each.id === packageId}
            onPress={() => onPick(each.id)}
          />
        ))}
      </Card>
    </>
  );
}

/** The times of day, one field each, up to `TIMES_MAX`. */
function TimesField({ times, read, attempted, onChange }: { times: readonly string[]; read: readonly (string | null)[]; attempted: boolean; onChange: (times: string[]) => void }) {
  return (
    <>
      <SectionHeader>{tr.doses.timesSection}</SectionHeader>
      {times.map((time, at) => (
        <View key={at} style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, marginBottom: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <TextField
              label={tr.doses.timeLabel(at + 1)}
              value={time}
              onChangeText={(text) => onChange(times.map((each, which) => (which === at ? text : each)))}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              error={attempted && read[at] == null ? tr.doses.timeInvalid : null}
            />
          </View>
          {times.length > 1 ? <IconButton icon={X} label={tr.doses.removeTime(time)} onPress={() => onChange(times.filter((_, which) => which !== at))} /> : null}
        </View>
      ))}
      {times.length < TIMES_MAX ? (
        <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
          <Button label={tr.doses.addTime} icon={Plus} variant="ghost" size="sm" onPress={() => onChange([...times, ""])} />
        </View>
      ) : null}
    </>
  );
}

/** The weekdays the plan asks on. */
function DaysField({ weekdays, error, onChange }: { weekdays: number; error: string | null; onChange: (weekdays: number) => void }) {
  return (
    <>
      <SectionHeader>{tr.doses.daysSection}</SectionHeader>
      <Card rows>
        {WEEKDAYS.map((bit, at) => (
          <ListRow key={bit} title={tr.doses.weekdayNames[at]!} selected={(weekdays & bit) !== 0} onPress={() => onChange(weekdays ^ bit)} />
        ))}
      </Card>
      {error ? <Notice tone="error" text={error} /> : null}
    </>
  );
}

/** Whether this phone rings for the plan: the person's choice here, kept on the device. */
function RingsHere({ plan }: { plan: CabinetDosePlan }) {
  const { me } = useHouseholds();
  const [ringing, setRinging] = useState<Record<string, boolean> | null>(null);
  useEffect(() => void readDoseRinging().then(setRinging, () => setRinging({})), []);
  if (!ringing) return null;
  const ring = (on: boolean) => {
    setRinging({ ...ringing, [plan.id]: on });
    void saveDoseRinging(plan.id, on).catch(() => appError(tr.errors.saveFailed));
  };
  return (
    <Card rows>
      <ToggleRow title={tr.doses.ringsHere} subtitle={tr.doses.ringsHereHint} value={ringsHere(plan, me, ringing)} onValueChange={ring} />
    </Card>
  );
}

/** A plan's page for one who only reads its cabinet; whoever may change it gets the form. */
function PlanPage({ plan, products }: { plan: CabinetDosePlan; products: readonly CabinetProduct[] }) {
  const { writes } = useHouseholds();
  const title = products.find((each) => each.id === plan.productId)?.name ?? plan.name;
  if (writes(plan.cabinetId)) return <PlanForm title={title} plan={plan} products={products} productId={plan.productId} packageId={plan.packageId} />;
  return (
    <Screen back="/doses" title={title} width="form">
      <ViewOnly cabinetId={plan.cabinetId} />
      <RingsHere plan={plan} />
      <PlanFacts plan={plan} />
    </Screen>
  );
}

/** Pause or take up a plan again, or delete it, each undone. */
function PlanActions({ plan, onDeleted }: { plan: CabinetDosePlan; onDeleted: () => void }) {
  const pause = async () => {
    try {
      const written = await editDosePlan(plan.id, { paused: !plan.paused });
      showUndo(plan.paused ? tr.doses.resumedNotice : tr.doses.pausedNotice, () => undoRows(written));
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };
  const remove = async () => {
    if (!(await appConfirm(tr.doses.deleteTitle, tr.doses.deleteBody, tr.doses.delete))) return;
    try {
      const written = await deleteDosePlans([plan.id]);
      onDeleted();
      if (written) showUndo(tr.doses.deleted, () => undoRows(written));
    } catch {
      await appError(tr.errors.deleteFailed);
    }
  };
  return (
    <>
      <Button label={plan.paused ? tr.doses.resume : tr.doses.pause} icon={plan.paused ? Play : Pause} variant="secondary" onPress={() => void pause()} />
      <Button label={tr.doses.delete} icon={Trash} variant="ghost" onPress={() => void remove()} />
    </>
  );
}

/**
 * The box chosen: the one asked for, else the only one at home, since a plan
 * with one box to take from takes from it. `undefined` until one is chosen.
 */
function useBoxChoice(product: CabinetProduct | undefined, asked: string | null, fixed: boolean) {
  const home = product?.boxes.filter((box) => box.disposition == null) ?? [];
  const [choice, setChoice] = useState<string | null | undefined>(fixed || asked ? asked : undefined);
  const only = home.length === 1 ? home[0]!.id : null;
  const packageId = choice === undefined ? only : choice;
  const box = product?.boxes.find((each) => each.id === packageId);
  return { home, choice, setChoice, packageId, box };
}

function PlanForm({ title, plan, products, productId: given, packageId: givenBox }: { title: string; plan?: CabinetDosePlan; products: readonly CabinetProduct[]; productId: string | null; packageId: string | null }) {
  const router = useRouter();
  const { writes, shows } = useHouseholds();
  const settings = useSettings();
  const offered = products.filter((each) => shows(each.cabinetId) && writes(each.cabinetId));
  const [productId, setProductId] = useState(given);
  const product = products.find((each) => each.id === productId);
  const { home, choice, setChoice, packageId, box } = useBoxChoice(product, givenBox, plan != null);
  const people = usePeople().data.filter((each) => each.cabinetId === product?.cabinetId);
  const [initial] = useState(() => fieldsOf(plan));
  const [fields, setFields] = useState(initial);
  const set = <K extends keyof PlanFields>(key: K, value: PlanFields[K]) => setFields((current) => ({ ...current, [key]: value }));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { allowExit } = useDirtyExitGuard(changed(fields, initial) || productId !== given || changed(choice ?? givenBox, givenBox));
  const leave = () => allowExit(() => navigateBack(router, "/doses"));
  const { amountMilli, times, startsOn, endsOn, errors } = readFields(fields);

  const save = async () => {
    setAttempted(true);
    setFailure(null);
    if (!product || times.some((time) => time == null) || Object.values(errors).some((error) => error != null)) return;
    if (!hasHealthConsent(settings.data)) {
      if (!(await appConfirm(tr.addBox.consentTitle, tr.addBox.consentBody, tr.addBox.consentConfirm))) return setFailure(tr.addBox.consentRequired);
      await giveHealthConsent();
    }
    setBusy(true);
    const written = { packageId, personId: fields.personId, amountMilli: amountMilli!, times: times as string[], weekdays: fields.weekdays, startsOn: startsOn!, endsOn, instructions: fields.instructions.trim() || null };
    try {
      if (plan) await editDosePlan(plan.id, written);
      else await addDosePlan({ productId: product.id, ...written });
      showNotice(tr.doses.saved);
      leave();
    } catch {
      setFailure(tr.doses.failed);
    }
    setBusy(false);
  };

  const field = (key: "amount" | "starts" | "ends" | "instructions", label: string, error: string | null, props: Partial<Parameters<typeof TextField>[0]> = {}) => (
    <TextField label={label} value={fields[key]} onChangeText={(text) => set(key, text)} error={attempted ? error : null} style={{ marginBottom: spacing.md }} {...props} />
  );

  return (
    <Screen back="/doses" title={title} width="form">
      {plan ? <RingsHere plan={plan} /> : null}
      <MedicinePick
        fixed={given != null}
        fallback={plan?.name}
        product={product}
        offered={offered}
        missing={attempted && !product}
        onPick={(id) => {
          setProductId(id);
          setChoice(undefined);
          set("personId", null);
        }}
      />

      {product && home.length > 0 ? <BoxPick home={home} packageId={packageId} onPick={setChoice} /> : null}

      {field("amount", tr.doses.amountLabel(box ? tr.units[box.unit] : null), errors.amount, { keyboardType: "decimal-pad", maxLength: 11 })}

      <TimesField times={fields.times} read={times} attempted={attempted} onChange={(each) => set("times", each)} />
      <DaysField weekdays={fields.weekdays} error={attempted ? errors.days : null} onChange={(each) => set("weekdays", each)} />

      {field("starts", tr.doses.startsOn, errors.starts, { placeholder: tr.placeholders.opened, keyboardType: "numbers-and-punctuation", maxLength: 10 })}
      {field("ends", tr.doses.endsOn, errors.ends, { placeholder: tr.placeholders.opened, keyboardType: "numbers-and-punctuation", maxLength: 10 })}
      {field("instructions", tr.doses.instructions, null, { examples: tr.doses.instructionsExamples, multiline: true, maxLength: 500 })}

      {product ? (
        <NamedChoices
          table="people"
          title={tr.doses.whoseSection}
          named={people}
          chosen={fields.personId}
          onChoose={(personId) => set("personId", personId)}
          onAdd={async (name) => set("personId", await addNamed("people", product.cabinetId, name))}
        />
      ) : null}

      {failure ? <Notice tone="error" text={failure} /> : null}
      <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
        <Button label={busy ? tr.doses.saving : tr.doses.save} icon={Save} disabled={busy} onPress={() => void save()} />
        {plan ? <PlanActions plan={plan} onDeleted={leave} /> : null}
      </View>
    </Screen>
  );
}
