import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import BriefcaseMedical from "lucide-react-native/icons/briefcase-medical";
import Archive from "lucide-react-native/icons/archive";
import FileText from "lucide-react-native/icons/file-text";
import FileUp from "lucide-react-native/icons/file-up";
import LayoutList from "lucide-react-native/icons/layout-list";
import FolderInput from "lucide-react-native/icons/folder-input";
import House from "lucide-react-native/icons/house";
import Package from "lucide-react-native/icons/package";
import Pill from "lucide-react-native/icons/pill";
import Plus from "lucide-react-native/icons/plus";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";
import Trash from "lucide-react-native/icons/trash";
import X from "lucide-react-native/icons/x";

import { deleteBoxes, editBoxes, type CabinetBox, type CabinetProduct, type Household, type Named, type NamedTable } from "../../data/cabinet";
import { useDocuments, useHouseholds, useLocations, usePeople, useShownCabinet, useTags } from "../../data/hooks";
import { BOX_VIEWS, SOON_DAYS, boxExpiry, expiryState, formatAmount, formatDay, inView, lastOpenDay, localDay, matchesSearch, sortProducts, type BoxView } from "../../domain/boxes";
import { tr } from "../../i18n/tr";
import { Body, Button, Card, ChoiceTile, EmptyState, IconButton, ListRow, ReadFailed, rowsOf, useTileColumns, Screen, TextField } from "../../ui/components";
import { undoRows } from "../../db/mutations";
import { takeCabinetFilter } from "../../ui/cabinet-link";
import { appError } from "../../ui/dialog";
import { radioGroupKeys } from "../../ui/keys";
import { useSelection } from "../../ui/selection";
import { kv } from "../../services/kv";
import { showUndo } from "../../ui/undo";
import { controlSize, spacing, useTheme } from "../../ui/theme";

type Sort = keyof typeof tr.cabinet.sorts;
const SORTS = Object.keys(tr.cabinet.sorts) as Sort[];

/** This device's choice of the short list: a view, not the cabinet's data. */
const COMPACT_KEY = "cabinet_compact";

/** The tag filter's tiles for starred products and those a document is linked to; a tag's id is a uuid, so these name none. */
const STARRED = "starred";
const LINKED = "linked";

interface Shown {
  query: string;
  sort: Sort;
  view: BoxView;
  person: string | null;
  place: string | null;
  /** A tag's id, `STARRED`, `LINKED`, or none. */
  tag: string | null;
  /** The products and boxes a live document names (F1.15, F3.4). */
  linked: ReadonlySet<string>;
  today: string;
  ownerOf: (personId: string | null) => string | undefined;
}

/** The products with a box that fits, each with only those boxes; a search finds a product by its names or a box by its nickname. */
function visible(products: readonly CabinetProduct[], { query, sort, view, person, place, tag, linked, today, ownerOf }: Shown): CabinetProduct[] {
  const fits = (box: CabinetBox) => inView(view, box, today) && (person == null || box.personId === person) && (place == null || box.locationId === place);
  const found = products
    .filter((product) => tag == null || tag === LINKED || (tag === STARRED ? product.starred : product.tagIds.includes(tag)))
    .map((product) => {
      const named = matchesSearch([product.name, product.brand, product.activeSubstance, product.strength, product.manufacturer, product.gtin], query);
      // A document linked to the product is for each of its boxes.
      const papered = (box: CabinetBox) => tag !== LINKED || linked.has(product.id) || linked.has(box.id);
      return { ...product, boxes: product.boxes.filter((box) => fits(box) && papered(box) && (named || matchesSearch([box.nickname], query))) };
    })
    .filter((product) => product.boxes.length > 0);
  return sortProducts(found, sort, ownerOf);
}

/** Dolabım: the boxes at home, grouped under their product, soonest to expire first. */
export default function Cabinet() {
  const columns = useTileColumns(3);
  const router = useRouter();
  const { palette } = useTheme();
  const cabinet = useShownCabinet();
  const { open, shows, writes } = useHouseholds();
  const people = usePeople().data.filter((each) => shows(each.cabinetId));
  const locations = useLocations().data.filter((each) => shows(each.cabinetId));
  const tags = useTags().data.filter((each) => shows(each.cabinetId));
  const documents = useDocuments().data.filter((each) => shows(each.cabinetId));
  const linked = new Set(documents.filter((each) => !each.archived).flatMap((each) => [...each.productIds, ...each.packageIds]));
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("expiry");
  const [whose, setWhose] = useState<string | null>(null);
  const [where, setWhere] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const [view, setView] = useState<BoxView>("home");
  const [compact, setCompact] = useState(false);
  // Sorting and the filters fold under one button, so the boxes start near the top; its label counts what is chosen.
  const [sifting, setSifting] = useState(false);
  // A Durum card's list: its filter alone, nothing left over from the last look.
  useFocusEffect(
    useCallback(() => {
      const filter = takeCabinetFilter();
      if (!filter) return;
      setQuery("");
      setView(filter.view);
      setWhose(filter.person);
      setWhere(null);
      setFiled(null);
    }, []),
  );
  useEffect(() => void kv.get(COMPACT_KEY).then((stored) => setCompact(stored === "true")), []);
  const toggleCompact = () => {
    setCompact(!compact);
    void kv.set(COMPACT_KEY, String(!compact));
  };
  const add = () => router.push("/add-box");
  const today = localDay();
  const nameOf = (named: readonly { id: string; name: string }[], id: string | null) => named.find((row) => row.id === id)?.name;

  // The icon warns of either end of the worst box at home; the title's word is the printed day's alone.
  const warning = (boxes: readonly CabinetBox[]) => {
    const states = boxes.map((box) => (box.disposition ? "ok" : boxExpiry(box, today)));
    return states.includes("expired") ? palette.error : states.includes("soon") ? palette.warning : undefined;
  };

  const subtitle = (box: CabinetBox) => {
    const openUntil = box.disposition ? null : lastOpenDay(box.openedOn, box.useWithinDays);
    return tr.common.joined(
      box.nickname ?? undefined,
      box.disposition ? tr.cabinet.dispositions[box.disposition] : undefined,
      openUntil ? tr.cabinet.openUntil(formatDay(openUntil)) : undefined,
      box.counted ? tr.cabinet.remaining(formatAmount(box.remainingMilli), tr.units[box.unit]) : tr.cabinet.uncounted,
      nameOf(people, box.personId),
      nameOf(locations, box.locationId),
    );
  };

  // A name deleted since it was chosen filters nothing.
  const person = people.some((each) => each.id === whose) ? whose : null;
  const place = locations.some((each) => each.id === where) ? where : null;
  const anyStarred = cabinet.data.some((product) => product.starred);
  // A product only on the to-buy list has nothing to show here.
  const holding = cabinet.data.some((product) => product.boxes.length > 0);
  // Each tile before the tags only while it would find something.
  const first = [...(anyStarred ? [{ id: STARRED, name: tr.cabinet.starred }] : []), ...(linked.size > 0 ? [{ id: LINKED, name: tr.documents.linked }] : [])];
  const tag = [...first, ...tags].some((each) => each.id === filed) ? filed : null;
  const chosenCount = [sort !== "expiry", view !== "home", person, place, tag].filter(Boolean).length;
  const shown = visible(cabinet.data, { query, sort, view, person, place, tag, linked, today, ownerOf: (id) => nameOf(people, id) });
  // A box of a household the person only reads is never chosen: everything chosen is changed.
  const selection = useSelection(shown.flatMap((product) => product.boxes).filter((box) => writes(box.cabinetId)));
  const chosenIds = () => selection.chosen.map((box) => box.id);

  // Both leave the boxes' rows to the undo bar: the selection ends as they go.
  const archive = async () => {
    const ids = chosenIds();
    selection.clear();
    try {
      const written = await editBoxes(ids, { disposition: "archived" });
      if (written) showUndo(tr.selection.archived(written.writes.length), () => undoRows(written));
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };
  const remove = async () => {
    const ids = chosenIds();
    selection.clear();
    try {
      const written = await deleteBoxes(ids);
      if (written) showUndo(tr.selection.deleted(written.writes.filter((write) => write.table === "packages").length), () => undoRows(written));
    } catch {
      await appError(tr.errors.deleteFailed);
    }
  };
  const header = selection.active
    ? {
        title: tr.selection.title(selection.count),
        actions: (
          <View style={{ flexDirection: "row", gap: spacing.xs }}>
            <IconButton icon={FolderInput} label={tr.selection.edit} onPress={() => router.push({ pathname: "/boxes", params: { ids: chosenIds().join(",") } })} />
            <IconButton icon={Archive} label={tr.selection.archive} onPress={() => void archive()} />
            <IconButton icon={Trash} label={tr.selection.delete} tone="danger" onPress={() => void remove()} />
            <IconButton icon={X} label={tr.selection.cancel} onPress={selection.clear} />
          </View>
        ),
      }
    : {
        title: tr.tabs.cabinet,
        actions:
          holding ? (
            <View style={{ flexDirection: "row", gap: spacing.xs }}>
              <IconButton icon={LayoutList} label={tr.cabinet.compact} on={compact} onPress={toggleCompact} />
              <IconButton icon={Plus} label={tr.cabinet.add} onPress={add} />
            </View>
          ) : null,
      };

  if (cabinet.status === "error") {
    return (
      <Screen title={tr.tabs.cabinet}>
        <ReadFailed queries={[cabinet]} />
      </Screen>
    );
  }
  // Rendering "empty" before the first read answers would flash the wrong screen.
  if (cabinet.status === "loading") return <Screen title={tr.tabs.cabinet} />;

  return (
    <Screen title={header.title} actions={header.actions}>
      <OpenHousehold household={open} />
      <Card rows>
        <ListRow icon={FileText} title={tr.documents.title} subtitle={tr.documents.count(documents.length)} chevron onPress={() => router.push("/documents")} />
      </Card>
      {!holding ? (
        <EmptyState
          icon={BriefcaseMedical}
          title={tr.cabinet.emptyTitle}
          hint={tr.cabinet.emptyHint}
          skeleton
          action={
            <View style={{ gap: spacing.sm, alignItems: "center" }}>
              <Button label={tr.cabinet.addFirst} icon={Plus} onPress={add} />
              <Button label={tr.importFile.title} icon={FileUp} variant="ghost" size="sm" onPress={() => router.push("/import")} />
            </View>
          }
        />
      ) : (
        <>
          <TextField
            accessibilityLabel={tr.cabinet.search}
            value={query}
            onChangeText={setQuery}
            examples={tr.cabinet.searchExamples}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={80}
            style={{ marginBottom: spacing.sm }}
          />
          <View style={{ alignItems: "flex-start", marginBottom: spacing.sm }}>
            <Button
              label={chosenCount > 0 ? tr.cabinet.siftChosen(chosenCount) : tr.cabinet.sift}
              icon={SlidersHorizontal}
              variant="secondary"
              size="sm"
              expanded={sifting}
              onPress={() => setSifting(!sifting)}
            />
          </View>
          {sifting ? (
            <>
              <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.cabinet.sortBy} style={{ gap: spacing.sm, marginBottom: spacing.md }}>
                {rowsOf(SORTS, columns).map((row, at) => (
                  <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
                    {row.map((value) => (
                      <ChoiceTile key={value} label={tr.cabinet.sorts[value]} selected={sort === value} minHeight={controlSize.minimumTarget} onPress={() => setSort(value)} />
                    ))}
                  </View>
                ))}
              </View>
              <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.cabinet.viewBy} style={{ gap: spacing.sm, marginBottom: spacing.md }}>
                {rowsOf(BOX_VIEWS, columns).map((row, at) => (
                  <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
                    {row.map((value) => (
                      <ChoiceTile key={value} label={tr.cabinet.views[value]} selected={view === value} minHeight={controlSize.minimumTarget} onPress={() => setView(value)} />
                    ))}
                  </View>
                ))}
              </View>
              <Filter table="people" named={people} chosen={person} onChoose={setWhose} />
              <Filter table="locations" named={locations} chosen={place} onChoose={setWhere} />
              <Filter table="tags" named={tags} first={first} chosen={tag} onChoose={setFiled} />
            </>
          ) : null}
          {shown.length === 0 ? <Body muted>{query.trim() ? tr.cabinet.noMatch(query.trim()) : tr.cabinet.noFiltered}</Body> : null}
          {shown.map((product) => (
            <Card key={product.id} rows>
              <ListRow
                icon={Pill}
                iconColor={compact ? warning(product.boxes) : undefined}
                title={tr.common.joined(product.name, product.strength ?? undefined)}
                subtitle={tr.common.joined(
                  // Whose cabinet, once there are two to tell apart.
                  open ? (product.cabinetId === open.id ? open.name : tr.households.private) : undefined,
                  tr.cabinet.boxes(product.boxes.length),
                  // The short list keeps a product's soonest day, which its first box carries.
                  // Said in words too: the icon's colour alone tells no screen reader, and warning and error are close.
                  compact && product.boxes[0]?.expiresOn
                    ? tr.common.joined(tr.cabinet.expires(formatDay(product.boxes[0].expiresOn)), tr.cabinet.expiryStates[expiryState(product.boxes[0].expiresOn, today, product.boxes[0].soonDays ?? SOON_DAYS)])
                    : undefined,
                  ...new Set(product.boxes.map((box) => nameOf(people, box.personId))),
                  product.activeSubstance ?? undefined,
                )}
                chevron
                onPress={() => router.push({ pathname: "/product/[id]", params: { id: product.id } })}
              />
              {compact ? null : product.boxes.map((box) => {
                const choosable = writes(box.cabinetId);
                return (
                  <ListRow
                    key={box.id}
                    icon={Package}
                    iconColor={warning([box])}
                    title={box.expiresOn ? tr.common.joined(tr.cabinet.expires(formatDay(box.expiresOn)), tr.cabinet.expiryStates[expiryState(box.expiresOn, today, box.soonDays ?? SOON_DAYS)]) : tr.cabinet.noExpiry}
                    subtitle={subtitle(box)}
                    chevron
                    onPress={() => (selection.active && choosable ? selection.toggle(box.id) : router.push({ pathname: "/box/[id]", params: { id: box.id } }))}
                    onLongPress={choosable ? () => selection.begin(box.id) : undefined}
                    selected={selection.active && choosable ? selection.has(box.id) : undefined}
                  />
                );
              })}
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}

/** The household shown beside the person's own boxes, and the way to another (F2.4). */
function OpenHousehold({ household }: { household: Household | null }) {
  const router = useRouter();
  return (
    <Card rows>
      <ListRow icon={House} title={household?.name ?? tr.households.none} subtitle={household ? tr.households.people(household.members) : tr.households.noneHint} chevron onPress={() => router.push("/households")} />
    </Card>
  );
}

/** Whose boxes, where, or which kind: "everyone" first, each name a tile, and the way to edit the names. Absent until there is a tile to choose. */
function Filter({
  table,
  named,
  first = [],
  chosen,
  onChoose,
}: {
  table: NamedTable;
  named: readonly Named[];
  /** Tiles before the names, that no name edit reaches. */
  first?: readonly Pick<Named, "id" | "name">[];
  chosen: string | null;
  onChoose: (id: string | null) => void;
}) {
  const columns = useTileColumns(3);
  const router = useRouter();
  if (named.length + first.length === 0) return null;
  const options: { id: string | null; name: string }[] = [{ id: null, name: tr.cabinet.everyone[table] }, ...first, ...named];
  return (
    <View style={{ marginBottom: spacing.sm }}>
      <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.names.title[table]} style={{ gap: spacing.sm }}>
        {rowsOf(options, columns).map((row, at) => (
          <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
            {row.map((option) => (
              <ChoiceTile key={option.id ?? "all"} label={option.name} selected={chosen === option.id} minHeight={controlSize.minimumTarget} onPress={() => onChoose(option.id)} />
            ))}
          </View>
        ))}
      </View>
      <View style={{ alignItems: "flex-start" }}>
        <Button label={tr.cabinet.editNames[table]} variant="ghost" size="sm" onPress={() => router.push({ pathname: "/names/[table]", params: { table } })} />
      </View>
    </View>
  );
}
