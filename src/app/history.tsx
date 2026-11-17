/**
 * Geçmiş ve Raporlar (`docs/TASKS.md` F4.1, F4.2): what happened to every box
 * in the cabinets Dolabım shows, and the reports made of it. The history is
 * the box pages' own — moves and edits, worded as there — across all boxes,
 * cut by what happened, by medicine, person, place and date. A deleted box was
 * a wrong record and is not in it. The rules are `src/domain/boxes.ts`'s.
 */

import { Fragment, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Archive from "lucide-react-native/icons/archive";
import CircleHelp from "lucide-react-native/icons/circle-question-mark";
import HistoryIcon from "lucide-react-native/icons/clock-fading";
import MapPin from "lucide-react-native/icons/map-pin";
import PackagePlus from "lucide-react-native/icons/package-plus";
import Pencil from "lucide-react-native/icons/pencil";
import Pill from "lucide-react-native/icons/pill";
import Share2 from "lucide-react-native/icons/share-2";
import User from "lucide-react-native/icons/user";

import type { Activity, CabinetProduct } from "../data/cabinet";
import { useActivity, useDosePlans, useHouseholds, useLocations, usePeople, useShownCabinet } from "../data/hooks";
import {
  HISTORY_KINDS,
  HISTORY_SPANS,
  SOON_DAYS,
  daysUntil,
  expiryState,
  filterHistory,
  formatAmount,
  formatDay,
  groupByDay,
  historyKind,
  isEmpty,
  leftCounts,
  localDay,
  missingInfo,
  remainingByUnit,
  type HistoryKind,
} from "../domain/boxes";
import { runsOn, timesOf } from "../domain/doses";
import { tr } from "../i18n/tr";
import { shareText } from "../services/share";
import { Body, Button, Card, ChipRow, Chips, ChoiceTile, DisclosureChip, EmptyState, ListRow, ReadFailed, rowsOf, Screen, Segmented, SectionHeader, TileGrid, useTileColumns } from "../ui/components";
import { appError } from "../ui/dialog";
import { daysOf, doseAmount } from "../ui/doses";
import { radioGroupKeys } from "../ui/keys";
import { changeLines, useWriter } from "../ui/named-choices";
import { alpha, controlSize, radius, spacing, type, useTheme } from "../ui/theme";
import { showNotice } from "../ui/undo";

/** All the thousand latest entries: a year of a household's use reads as one list, and the counts are of what was read. */
const READ_LIMIT = 1000;

const KIND_ICONS = { use: Pill, added: PackagePlus, edit: Pencil, left: Archive } as const;

/** What tints each kind's tile: a use wears the brand's, and the others a status colour of their own. */
const KIND_TONES = { use: undefined, added: "success", edit: "secondary", left: "error" } as const;

type Tab = "history" | "reports";
type Which = "product" | "person" | "place";

interface Choice<T> {
  id: T;
  name: string;
}

/** One answer of a radio group among tiles, in rows of `wanted` at most; a short last row keeps the tiles' width. */
function Choices<T extends string | number | null>({ label, options, chosen, wanted, onChoose }: { label: string; options: readonly Choice<T>[]; chosen: T; wanted: number; onChoose: (id: T) => void }) {
  const columns = useTileColumns(wanted);
  return (
    <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={label} style={{ gap: spacing.sm, marginBottom: spacing.md }}>
      {rowsOf(options, columns).map((row, at) => (
        <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
          {row.map((option) => (
            <ChoiceTile key={String(option.id)} label={option.name} selected={chosen === option.id} minHeight={controlSize.minimumTarget} onPress={() => onChoose(option.id)} />
          ))}
          {Array.from({ length: columns - row.length }, (_, spare) => (
            <View key={`spare${spare}`} style={{ flex: 1 }} />
          ))}
        </View>
      ))}
    </View>
  );
}

const nameOf = (product: CabinetProduct) => tr.common.joined(product.name, product.strength ?? undefined);

export default function HistoryScreen() {
  const { me, open } = useHouseholds();
  const cabinet = useShownCabinet();
  const activity = useActivity(
    [me, open?.id].filter((id): id is string => id != null),
    READ_LIMIT,
  );
  const [tab, setTab] = useState<Tab>("history");
  const tabs: Choice<Tab>[] = [
    { id: "history", name: tr.history.views.history },
    { id: "reports", name: tr.history.views.reports },
  ];

  if (activity.status === "error" || cabinet.status === "error") {
    return (
      <Screen back="/" title={tr.history.title}>
        <ReadFailed queries={[activity, cabinet]} />
      </Screen>
    );
  }
  if (activity.status === "loading" || cabinet.status === "loading") return <Screen back="/" title={tr.history.title} />;

  return (
    <Screen back="/" title={tr.history.title}>
      <Segmented label={tr.history.viewBy} options={tabs} chosen={tab} onChoose={setTab} />
      {tab === "history" ? <HistoryTab entries={activity.data} products={cabinet.data} /> : <ReportsTab entries={activity.data} products={cabinet.data} />}
    </Screen>
  );
}

/** Today and yesterday by name, any other day by its date. */
function heading(day: string, today: string): string {
  const ago = daysUntil(day, today);
  return ago === 0 ? tr.history.today : ago === -1 ? tr.history.yesterday : formatDay(day);
}

function HistoryTab({ entries, products }: { entries: readonly Activity[]; products: readonly CabinetProduct[] }) {
  const router = useRouter();
  const { open, shows } = useHouseholds();
  const writer = useWriter(open?.id);
  const everyone = usePeople().data;
  const everywhere = useLocations().data;
  const [kind, setKind] = useState<HistoryKind | null>(null);
  const [days, setDays] = useState<number | null>(HISTORY_SPANS[1]);
  const [chosen, setChosen] = useState<Record<Which, string | null>>({ product: null, person: null, place: null });
  const [picking, setPicking] = useState<Which | null>(null);
  const today = localDay();
  const { palette } = useTheme();
  const tone = (kind: HistoryKind) => (KIND_TONES[kind] ? palette[KIND_TONES[kind]] : undefined);

  const options: Record<Which, Choice<string>[]> = {
    product: products.filter((product) => product.boxes.length > 0).map((product) => ({ id: product.id, name: nameOf(product) })),
    person: everyone.filter((each) => shows(each.cabinetId)),
    place: everywhere.filter((each) => shows(each.cabinetId)),
  };
  // A name deleted since it was chosen filters nothing.
  const live = (which: Which) => options[which].find((option) => option.id === chosen[which]);
  const picks: { id: Which; title: string; icon: typeof User }[] = [
    { id: "product", title: tr.history.filters.product, icon: Pill },
    { id: "person", title: tr.history.filters.person, icon: User },
    { id: "place", title: tr.history.filters.place, icon: MapPin },
  ];

  const shown = filterHistory(entries, { kind, days, productId: live("product")?.id ?? null, personId: live("person")?.id ?? null, locationId: live("place")?.id ?? null }, today);

  // An edit says what it changed, as the box's own history does; the writer is named only in a household.
  const said = (each: Activity) =>
    each.changes
      ? changeLines(each.changes, tr.units[each.unit], everyone, everywhere, (user) => (each.cabinetId === open?.id ? writer(user) : undefined)) || tr.box.changed
      : tr.box.move(each.reason!, each.quantityMilli ?? 0, tr.units[each.unit]);

  if (entries.length === 0) return <EmptyState icon={HistoryIcon} title={tr.history.emptyTitle} hint={tr.history.emptyHint} />;
  return (
    <>
      <Chips label={tr.history.kindBy} options={[{ id: null, name: tr.history.allKinds }, ...HISTORY_KINDS.map((each) => ({ id: each, name: tr.history.kinds[each] }))]} chosen={kind} onChoose={setKind} />
      <Chips label={tr.history.spanBy} options={[...HISTORY_SPANS, null].map((each) => ({ id: each, name: tr.history.span(each) }))} chosen={days} onChoose={setDays} />
      <ChipRow>
        {picks.map((pick) =>
          options[pick.id].length === 0 ? null : (
            <DisclosureChip
              key={pick.id}
              label={tr.history.filterChosen(pick.title, live(pick.id)?.name ?? tr.history.everything)}
              icon={pick.icon}
              expanded={picking === pick.id}
              onPress={() => setPicking(picking === pick.id ? null : pick.id)}
            />
          ),
        )}
      </ChipRow>
      {picks.map((pick) =>
        picking === pick.id && options[pick.id].length > 0 ? (
          <Choices
            key={pick.id}
            label={pick.title}
            options={[{ id: null, name: tr.history.everything }, ...options[pick.id]]}
            chosen={live(pick.id)?.id ?? null}
            wanted={2}
            onChoose={(id) => {
              setChosen({ ...chosen, [pick.id]: id });
              setPicking(null);
            }}
          />
        ) : null,
      )}
      {shown.length === 0 ? <Body muted>{tr.history.noMatch}</Body> : null}
      {groupByDay(shown).map(({ day, entries: dayEntries }) => (
        <Fragment key={day}>
          <SectionHeader>{heading(day, today)}</SectionHeader>
          <Card rows>
            {dayEntries.map((each) => (
              <ListRow
                key={each.id}
                icon={KIND_ICONS[historyKind(each)]}
                iconColor={tone(historyKind(each))}
                title={each.name}
                subtitle={tr.common.joined(said(each), each.cabinetId === open?.id ? writer(each.by) : undefined, tr.history.time(each.at))}
                chevron
                onPress={() => router.push({ pathname: "/box/[id]", params: { id: each.boxId } })}
              />
            ))}
          </Card>
        </Fragment>
      ))}
    </>
  );
}

/** One count of the summary card: the figure, what it counts, and when there is more to say, that. */
function Figure({ value, label, detail, tone }: { value: number; label: string; detail?: string; tone?: "error" | "warning" }) {
  const { palette } = useTheme();
  // A count that asks for a look is tinted as its status is; a quiet one is a plain card.
  const tinted = tone != null && value > 0;
  const ink = tinted ? (tone === "error" ? palette.errorText : palette.warningText) : palette.text;
  return (
    <View
      style={{
        flex: 1,
        flexBasis: 0,
        minWidth: 0,
        padding: spacing.md,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: tinted ? 0 : StyleSheet.hairlineWidth,
        borderColor: palette.border + alpha.edge,
        backgroundColor: tinted ? palette[tone] + alpha.noticeTint : palette.surface,
      }}
    >
      <Text style={[type.amount, { color: ink }]}>{value}</Text>
      <Text style={[type.body, { color: ink }]}>{label}</Text>
      {detail ? <Text style={[type.small, { color: tinted ? ink : palette.textSecondary }]}>{detail}</Text> : null}
    </View>
  );
}

function ReportsTab({ entries, products }: { entries: readonly Activity[]; products: readonly CabinetProduct[] }) {
  const router = useRouter();
  const { shows } = useHouseholds();
  const plans = useDosePlans().data.filter((plan) => shows(plan.cabinetId));
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const today = localDay();

  const boxes = products.flatMap((product) => product.boxes);
  const left = leftCounts(entries, today);
  const missing = missingInfo(products);
  const medicines = products.filter((product) => product.boxes.some((box) => box.disposition == null));
  const chosen = medicines.filter((product) => picked.has(product.id));
  // As Durum counts them, so a figure here is the one on its card: the printed day alone, and nothing for a box with nothing left.
  const expiring = (state: "soon" | "expired") => boxes.filter((box) => box.disposition == null && !isEmpty(box) && expiryState(box.expiresOn, today, box.soonDays ?? SOON_DAYS) === state).length;
  const figures: ReactNode[] = [
    <Figure key="soon" value={expiring("soon")} label={tr.history.tiles.soon} tone="warning" />,
    <Figure key="expired" value={expiring("expired")} label={tr.history.tiles.expired} tone="error" />,
    <Figure key="missing" value={missing.length} label={tr.history.tiles.missing} />,
    <Figure key="left" value={left.archived + left.disposed + left.lost} label={tr.history.tiles.left} detail={tr.history.leftDetail(left.archived, left.disposed, left.lost)} />,
  ];

  const remainingOf = (product: CabinetProduct) => {
    const parts = remainingByUnit(product.boxes).map(({ unit, milli }) => tr.doses.amount(formatAmount(milli), tr.units[unit]));
    return parts.length > 0 ? parts.join(" + ") : null;
  };
  const toggle = (id: string) => setPicked(picked.has(id) ? new Set([...picked].filter((each) => each !== id)) : new Set([...picked, id]));
  const share = async () => {
    const text = tr.history.text(
      formatDay(today),
      chosen.map((product) =>
        tr.history.medicine(
          tr.common.joined(product.name, product.strength ?? undefined, product.form ?? undefined),
          product.activeSubstance ?? null,
          remainingOf(product),
          plans.filter((plan) => plan.productId === product.id && runsOn(plan, today)).map((plan) => tr.common.joined(doseAmount(plan), timesOf(plan.times).join(", "), daysOf(plan.weekdays))),
        ),
      ),
    );
    try {
      if ((await shareText(text)) === "clipboard") showNotice(tr.history.copied);
    } catch {
      await appError(tr.errors.shareFailed);
    }
  };

  return (
    <>
      <View style={{ marginBottom: spacing.md }}>
        <TileGrid wanted={2}>{figures}</TileGrid>
      </View>
      {missing.length === 0 ? null : (
        <>
          <SectionHeader>{tr.history.missingSection}</SectionHeader>
          <Card rows>
            {missing.map(({ product, box }) => (
              <ListRow
                key={box?.id ?? product.id}
                icon={CircleHelp}
                title={box ? tr.common.boxName(product, box) : nameOf(product)}
                subtitle={box ? tr.cabinet.noExpiry : tr.history.noSubstance}
                chevron
                onPress={() => router.push(box ? { pathname: "/box/[id]", params: { id: box.id } } : { pathname: "/product/[id]", params: { id: product.id } })}
              />
            ))}
          </Card>
        </>
      )}
      {medicines.length === 0 ? null : (
        <>
          <SectionHeader>{tr.history.doctorSection}</SectionHeader>
          <Body muted style={{ marginBottom: spacing.sm }}>{tr.history.doctorHint}</Body>
          <Card rows>
            {medicines.map((product) => {
              const remaining = remainingOf(product);
              return (
                <ListRow
                  key={product.id}
                  icon={Pill}
                  title={nameOf(product)}
                  subtitle={tr.common.joined(product.form ?? undefined, product.activeSubstance ?? undefined, remaining ? tr.history.remaining(remaining) : tr.cabinet.uncounted)}
                  selected={picked.has(product.id)}
                  onPress={() => toggle(product.id)}
                />
              );
            })}
          </Card>
          {chosen.length === 0 ? null : (
            <>
              <Button label={tr.history.share(chosen.length)} icon={Share2} onPress={() => void share()} />
              <Body muted style={{ marginTop: spacing.sm }}>{tr.history.shareCaption}</Body>
            </>
          )}
        </>
      )}
    </>
  );
}
