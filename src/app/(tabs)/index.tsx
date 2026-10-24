import { Fragment, useCallback, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import Archive from "lucide-react-native/icons/archive";
import Bell from "lucide-react-native/icons/bell";
import CalendarX from "lucide-react-native/icons/calendar-x";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import Clock from "lucide-react-native/icons/clock";
import FileUp from "lucide-react-native/icons/file-up";
import House from "lucide-react-native/icons/house";
import ListFilter from "lucide-react-native/icons/list-filter";
import Package from "lucide-react-native/icons/package";
import PackageMinus from "lucide-react-native/icons/package-minus";
import PackageOpen from "lucide-react-native/icons/package-open";
import PackageX from "lucide-react-native/icons/package-x";
import Pill from "lucide-react-native/icons/pill";
import Plus from "lucide-react-native/icons/plus";
import ScanLine from "lucide-react-native/icons/scan-line";
import Search from "lucide-react-native/icons/search";
import RotateCcwClock from "lucide-react-native/icons/rotate-ccw-clock";
import ShoppingBasket from "lucide-react-native/icons/shopping-basket";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";

import type { CabinetBox, CabinetProduct } from "../../data/cabinet";
import { useDoseAnswers, useDosePlans, useHouseholds, usePeople, useShownCabinet } from "../../data/hooks";
import { OPENED_SOON_DAYS, SOON_DAYS, daysUntil, expiryState, formatAmount, formatDay, inView, isEmpty, isLow, lastOpenDay, localDay, matchesSearch, type BoxView, type ExpiryState } from "../../domain/boxes";
import { dosesOfDay } from "../../domain/doses";
import { tr } from "../../i18n/tr";
import { canScan } from "../../services/barcode-scan";
import { Attention } from "../../ui/attention";
import { openCabinet } from "../../ui/cabinet-link";
import { Body, Button, Card, EmptyState, IconButton, ListRow, Notice, ReadFailed, Screen, SectionHeader, TextField } from "../../ui/components";
import { PersonMark } from "../../ui/named-choices";
import { useNotices } from "../../ui/notices";
import { readCardLayout, layoutFrom, type CardLayout, type StatusCard } from "../../ui/status-cards";
import { spacing, type, useTheme } from "../../ui/theme";
import { FirstRunTour } from "../../ui/tour";

type Held = { product: CabinetProduct; box: CabinetBox };

/** How many boxes the last-changed card names. */
const RECENT = 5;

/** The summary of a box's life, each a filter of Dolabım: what is at home was said above. */
const STAGES: readonly [BoxView, typeof Package][] = [
  ["unopened", Package],
  ["open", PackageOpen],
  ["empty", PackageX],
  ["gone", Archive],
];

/** The boxes at home by what they ask for; they come soonest first, so each list is in the order its days arrive. */
function sorted(home: Held[], today: string) {
  const by: Record<ExpiryState, Held[]> = { expired: [], soon: [], ok: [], unknown: [] };
  const opened: Held[] = [];
  const stock: Held[] = [];
  for (const held of home) {
    if (isEmpty(held.box) || isLow(held.box)) stock.push(held);
    // An empty box's days no longer matter.
    if (isEmpty(held.box)) continue;
    by[expiryState(held.box.expiresOn, today, held.box.soonDays ?? SOON_DAYS)].push(held);
    const openState = expiryState(lastOpenDay(held.box.openedOn, held.box.useWithinDays), today, OPENED_SOON_DAYS);
    if (openState === "expired" || openState === "soon") opened.push(held);
  }
  return { by, opened, stock };
}

/**
 * "Evde var mı?" (`docs/TASKS.md` F1.27): answered where it is asked, from the
 * boxes at home that still hold something, by Dolabım's own search.
 */
function HomeCheck({ home, subtitle, open }: { home: Held[]; subtitle: (box: CabinetBox) => string; open: (box: CabinetBox) => void }) {
  const [query, setQuery] = useState("");
  const asked = query.trim();
  const found = asked
    ? home.filter(({ product, box }) => !isEmpty(box) && matchesSearch([product.name, product.brand, product.activeSubstance, product.strength, product.manufacturer, product.gtin, box.nickname], asked))
    : [];
  return (
    <>
      <SectionHeader>{tr.status.homeCheck}</SectionHeader>
      <TextField
        accessibilityLabel={tr.status.homeCheck}
        value={query}
        onChangeText={setQuery}
        examples={tr.cabinet.searchExamples}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={80}
        style={{ marginBottom: spacing.sm }}
      />
      {asked ? <Body muted>{found.length > 0 ? tr.status.atHome(found.length) : tr.status.notAtHome(asked)}</Body> : null}
      {found.length > 0 ? (
        <Card rows>
          {found.map(({ product, box }) => (
            <ListRow key={box.id} icon={Package} title={tr.common.boxName(product, box)} subtitle={subtitle(box)} chevron onPress={() => open(box)} />
          ))}
        </Card>
      ) : null}
    </>
  );
}

/**
 * Durum (`docs/TASKS.md` F1.22, F1.23, F1.26): what the cabinet holds, then
 * its cards in the order this device keeps — the boxes whose day has come or
 * is coming, the lists drawn from them, each box's stage, whose they are, and
 * what changed last. A card opens Dolabım's list with its filter set.
 */
export default function Status() {
  const router = useRouter();
  const { palette } = useTheme();
  const cabinet = useShownCabinet();
  const people = usePeople();
  const { shows } = useHouseholds();
  const plans = useDosePlans().data.filter((plan) => shows(plan.cabinetId));
  const answers = useDoseAnswers(localDay(), localDay()).data.filter((answer) => shows(answer.cabinetId));
  const { unread } = useNotices();
  const [layout, setLayout] = useState<CardLayout | null>(null);
  useFocusEffect(useCallback(() => void readCardLayout().then(setLayout, () => setLayout(layoutFrom(null))), []));
  const add = () => router.push("/add-box");

  if (cabinet.status === "error") {
    return (
      <Screen title={tr.tabs.status}>
        <ReadFailed queries={[cabinet]} />
      </Screen>
    );
  }
  if (cabinet.status === "loading") return <Screen title={tr.tabs.status} />;
  if (cabinet.data.length === 0) {
    return (
      <Screen title={tr.tabs.status}>
        <Attention />
        <EmptyState icon={House} title={tr.status.emptyTitle} hint={tr.status.emptyHint} skeleton action={<Button label={tr.cabinet.addFirst} icon={Plus} onPress={add} />} />
        <FirstRunTour />
      </Screen>
    );
  }

  const today = localDay();
  const all = cabinet.data.flatMap((product) => product.boxes.map((box) => ({ product, box })));
  // A box that left the cabinet asks for nothing.
  const home = all.filter(({ box }) => box.disposition == null);
  const { by, opened, stock } = sorted(home, today);
  const products = new Set(home.map(({ product }) => product.id)).size;
  const open = (box: CabinetBox) => router.push({ pathname: "/box/[id]", params: { id: box.id } });
  const left = (day: string) => {
    const days = daysUntil(day, today);
    return days < 0 ? tr.status.daysAgo(-days) : tr.status.daysLeft(days);
  };
  const printed = (box: CabinetBox) => (box.expiresOn ? tr.common.joined(tr.cabinet.expires(formatDay(box.expiresOn)), left(box.expiresOn)) : tr.cabinet.noExpiry);
  const openEnd = (box: CabinetBox) => {
    const day = lastOpenDay(box.openedOn, box.useWithinDays)!;
    return tr.common.joined(tr.cabinet.openUntil(formatDay(day)), left(day));
  };
  const amount = (box: CabinetBox) => (isEmpty(box) ? tr.status.usedUp : tr.cabinet.remaining(formatAmount(box.remainingMilli), tr.units[box.unit]));
  const changed = (box: CabinetBox) => {
    const day = formatDay(localDay(new Date(box.updatedAt)));
    return box.updatedAt === box.createdAt ? tr.status.added(day) : tr.status.edited(day);
  };

  const boxRows = (held: Held[], icon: typeof Clock, tone: "error" | "warning" | null, subtitle: (box: CabinetBox) => string) =>
    held.map(({ product, box }) => (
      <ListRow
        key={box.id}
        icon={icon}
        iconColor={tone ? palette[tone] : undefined}
        title={tr.common.boxName(product, box)}
        subtitle={subtitle(box)}
        chevron
        onPress={() => open(box)}
      />
    ));
  const card = (title: string, rows: ReactNode[]) =>
    rows.length === 0 ? null : (
      <>
        <SectionHeader>{title}</SectionHeader>
        <Card rows>{rows}</Card>
      </>
    );
  // The first few, soonest first, and a last row that opens them all in Dolabım's list, with what it does there.
  const listCard = (title: string, held: Held[], view: BoxView, icon: typeof Clock, tone: "error" | "warning" | null, subtitle: (box: CabinetBox) => string) =>
    card(title, held.length === 0 ? [] : [...boxRows(held.slice(0, RECENT), icon, tone, subtitle), <ListRow key="all" icon={ListFilter} title={tr.status.seeAll} chevron onPress={() => openCabinet({ view })} />]);

  const owned = people.data.flatMap((person) => {
    const count = home.filter(({ box }) => box.personId === person.id).length;
    return count === 0 ? [] : [{ person, count }];
  });
  const doses = dosesOfDay(plans, answers, today, new Date());
  // Put off, a dose is still to be answered, as the calendar says.
  const next = doses.find((dose) => dose.state === "due" || dose.state === "upcoming" || dose.state === "snoozed");
  const nameOf = (planId: string) => plans.find((plan) => plan.id === planId)?.name ?? "";
  const recent = [...all].sort((a, b) => b.box.updatedAt.localeCompare(a.box.updatedAt)).slice(0, RECENT);
  const cards: Record<StatusCard, ReactNode> = {
    doses:
      doses.length === 0
        ? null
        : card(tr.doses.todaySection, [
            <ListRow
              key="next"
              icon={Pill}
              iconColor={next?.state === "due" ? palette.warning : undefined}
              title={next ? tr.common.joined(tr.doses.next(next.dueTime, nameOf(next.planId)), next.state === "due" ? tr.doses.states.due : undefined) : tr.doses.allAnswered}
              subtitle={tr.doses.todayCount(doses.filter((dose) => dose.state === "taken").length, doses.length)}
              chevron
              onPress={() => router.push("/doses")}
            />,
          ]),
    lists: card(tr.status.listsSection, [
      <ListRow key="buy" icon={ShoppingBasket} title={tr.toBuy.title} subtitle={tr.toBuy.count(cabinet.data.filter((product) => product.wanted).length)} chevron onPress={() => router.push("/to-buy")} />,
      ...(by.expired.length > 0
        ? [<ListRow key="dispose" icon={PackageX} iconColor={palette.error} title={tr.toDispose.title} subtitle={tr.toDispose.count(by.expired.length)} chevron onPress={() => router.push("/to-dispose")} />]
        : []),
    ]),
    expired: listCard(tr.status.expiredSection, by.expired, "expired", CalendarX, "error", printed),
    soon: listCard(tr.status.soonSection, by.soon, "soon", Clock, "warning", printed),
    opened: listCard(tr.status.openedSection, opened, "open", PackageOpen, "warning", openEnd),
    stock: listCard(tr.status.stockSection, stock, "low", PackageMinus, null, amount),
    undated: listCard(tr.status.undatedSection, by.unknown, "undated", Clock, null, printed),
    boxes: card(
      tr.status.boxesSection,
      STAGES.flatMap(([view, icon]) => {
        const count = all.filter(({ box }) => inView(view, box, today)).length;
        return count === 0 ? [] : [<ListRow key={view} icon={icon} title={tr.cabinet.views[view]} subtitle={tr.status.boxes(count)} chevron onPress={() => openCabinet({ view })} />];
      }),
    ),
    people: card(
      tr.status.peopleSection,
      owned.map(({ person, count }) => (
        <ListRow key={person.id} leading={<PersonMark person={person} />} title={person.name} subtitle={tr.status.boxes(count)} chevron onPress={() => openCabinet({ person: person.id })} />
      )),
    ),
    recent: card(tr.status.recentSection, boxRows(recent, RotateCcwClock, null, changed)),
  };

  return (
    <Screen
      title={tr.tabs.status}
      actions={
        <View style={{ flexDirection: "row", gap: spacing.xs }}>
          <IconButton icon={SlidersHorizontal} label={tr.statusCards.title} onPress={() => router.push("/status-cards")} />
          <IconButton
            icon={Bell}
            label={tr.common.withDetail(tr.notices.title, tr.notices.count(unread))}
            text={unread > 0 ? String(unread) : undefined}
            tone={unread > 0 ? "primary" : "default"}
            onPress={() => router.push("/notices")}
          />
        </View>
      }
    >
      <Attention />
      <Card>
        <Body muted>{tr.status.summaryHint}</Body>
        <Text style={[type.title, { color: palette.text, marginBottom: spacing.md }]}>{tr.status.summary(products, home.length)}</Text>
        <View style={{ gap: spacing.sm }}>
          {canScan ? <Button label={tr.addBox.scan} icon={ScanLine} variant="secondary" onPress={() => router.push({ pathname: "/add-box", params: { scan: "1" } })} /> : null}
          <Button label={tr.cabinet.add} icon={Plus} variant="secondary" onPress={add} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            <Button label={tr.catalogue.search} icon={Search} variant="ghost" size="sm" onPress={() => router.push({ pathname: "/add-box", params: { search: "1" } })} />
            <Button label={tr.doses.quickAdd} icon={CalendarClock} variant="ghost" size="sm" onPress={() => router.push("/dose-plan")} />
            <Button label={tr.doses.uploadPrescription} icon={FileUp} variant="ghost" size="sm" onPress={() => router.push("/add-document")} />
          </View>
        </View>
      </Card>
      <HomeCheck home={home} subtitle={printed} open={open} />
      {by.expired.length + by.soon.length + opened.length === 0 ? <Notice tone="success" text={tr.status.allGood} /> : null}
      {layout?.order.filter((id) => !layout.hidden.includes(id)).map((id) => <Fragment key={id}>{cards[id]}</Fragment>)}
      <FirstRunTour />
    </Screen>
  );
}

