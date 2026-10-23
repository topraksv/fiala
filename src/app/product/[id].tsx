/**
 * One medicine as the cabinet knows it (`docs/TASKS.md` F1.19): its fields,
 * note and photo, its star and tags (F1.17), whether it is on the list to buy
 * (F1.23), what is left across its boxes and for whom, each box apart, and
 * its dose plans (F3.7).
 * A change here is the product's; a box keeps its own days and amount.
 */

import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Package from "lucide-react-native/icons/package";
import Plus from "lucide-react-native/icons/plus";
import Star from "lucide-react-native/icons/star";
import Tag from "lucide-react-native/icons/tag";
import TagPlus from "lucide-react-native/icons/tag-plus";

import { addNamed, editProduct, setPhoto, tagProduct, type CabinetBox, type Named, type ProductFields } from "../../data/cabinet";
import { useCabinet, useHouseholds, usePeople, useTags } from "../../data/hooks";
import { formatAmount, formatDay, printedGtin } from "../../domain/boxes";
import type { NewPhoto } from "../../data/photos";
import { tr } from "../../i18n/tr";
import { Button, Card, IconButton, ListRow, Notice, Screen, SectionHeader, ToggleRow } from "../../ui/components";
import { appError, appPrompt } from "../../ui/dialog";
import { LinkedDocuments } from "../../ui/documents";
import { ProductPlans } from "../../ui/doses";
import { PersonMark, ViewOnly } from "../../ui/named-choices";
import { PhotoField } from "../../ui/photo-field";
import { spacing } from "../../ui/theme";

type Editable = keyof Omit<ProductFields, "gtin">;

/** Each field, its label and the server's ceiling, so a refusal is said here rather than set aside by sync. */
const FIELDS: readonly [Editable, string, number][] = [
  ["name", tr.addBox.name, 200],
  ["activeSubstance", tr.addBox.substance, 500],
  ["strength", tr.addBox.strength, 100],
  ["form", tr.addBox.form, 100],
  ["pack", tr.addBox.pack, 100],
  ["brand", tr.addBox.brand, 200],
  ["manufacturer", tr.addBox.manufacturer, 200],
];

/** What the counted boxes hold, unit by unit: two units never add up. */
function totals(boxes: readonly CabinetBox[]): string | undefined {
  const byUnit = new Map<CabinetBox["unit"], number>();
  for (const box of boxes) if (box.counted) byUnit.set(box.unit, (byUnit.get(box.unit) ?? 0) + box.remainingMilli);
  return byUnit.size ? [...byUnit].map(([unit, milli]) => `${formatAmount(milli)} ${tr.units[unit]}`).join(", ") : undefined;
}

export default function ProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const cabinet = useCabinet();
  const people = usePeople();
  const allTags = useTags();
  const { writes } = useHouseholds();
  const product = cabinet.data.find((each) => each.id === id);
  const tags = allTags.data.filter((tag) => tag.cabinetId === product?.cabinetId);

  if (!product) {
    return (
      <Screen back="/cabinet" title={tr.tabs.cabinet}>
        {cabinet.status === "loading" ? null : <Notice tone="error" text={tr.product.notFound} />}
      </Screen>
    );
  }

  const editable = writes(product.cabinetId);
  // What only someone who may change the product is given.
  const changing = <T,>(control: T) => (editable ? control : undefined);
  const attempt = async (write: () => Promise<unknown>) => {
    try {
      await write();
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };
  const change = async (field: Editable | "note", label: string, maxLength: number) => {
    const typed = await appPrompt(label, field === "note" ? tr.product.noteMessage : "", {
      confirmLabel: tr.common.save,
      initialValue: product[field] ?? "",
      examples: field === "note" ? tr.product.noteExamples : undefined,
      multiline: field === "note",
      maxLength,
    });
    // A name is never emptied; any other field emptied is no longer known.
    if (typed == null || (field === "name" && !typed.trim())) return;
    await attempt(() => editProduct(product.id, { [field]: typed.trim() || null }));
  };

  const addTag = async () => {
    const name = (await appPrompt(tr.names.add.tags, tr.names.hint.tags, { confirmLabel: tr.addBox.add, examples: tr.placeholders.tag, maxLength: 80 }))?.trim();
    if (name) await attempt(async () => tagProduct(product.id, await addNamed("tags", product.cabinetId, name), true));
  };

  // What is left is what is at home: a box lost, thrown away or archived keeps its record, not its count.
  const home = product.boxes.filter((box) => box.disposition == null);
  const whose = [...new Set(home.map((box) => box.personId))].map((personId) => ({
    personId,
    person: people.data.find((person) => person.id === personId),
    amounts: totals(home.filter((box) => box.personId === personId)),
  }));

  return (
    <Screen
      back="/cabinet"
      title={product.name}
      actions={changing(<IconButton icon={Star} label={tr.product.star} on={product.starred} onPress={() => void attempt(() => editProduct(product.id, { starred: !product.starred }))} />)}
    >
      <ViewOnly cabinetId={product.cabinetId} />
      <SectionHeader>{tr.product.totalSection}</SectionHeader>
      <Card rows>
        <ListRow title={tr.product.total(totals(home) ?? tr.cabinet.uncounted)} subtitle={tr.cabinet.boxes(home.length)} />
        {whose.length > 1 || whose[0]?.personId
          ? whose.map((each) => (
              <ListRow
                key={each.personId ?? "none"}
                leading={each.person ? <PersonMark person={each.person} /> : undefined}
                title={each.person?.name ?? tr.cabinet.unassigned}
                subtitle={each.amounts ?? tr.cabinet.uncounted}
              />
            ))
          : null}
      </Card>
      {editable ? (
        <Card rows>
          <ToggleRow title={tr.product.wanted} subtitle={tr.product.wantedHint} value={product.wanted} onValueChange={(wanted) => void attempt(() => editProduct(product.id, { wanted }))} />
        </Card>
      ) : null}

      <SectionHeader>{tr.product.boxesSection}</SectionHeader>
      <Card rows>
        {product.boxes.map((box) => (
          <ListRow
            key={box.id}
            icon={Package}
            title={box.expiresOn ? tr.cabinet.expires(formatDay(box.expiresOn)) : tr.cabinet.noExpiry}
            subtitle={tr.common.joined(
              box.nickname ?? undefined,
              box.disposition ? tr.cabinet.dispositions[box.disposition] : undefined,
              box.counted ? tr.cabinet.remaining(formatAmount(box.remainingMilli), tr.units[box.unit]) : tr.cabinet.uncounted,
            )}
            chevron
            onPress={() => router.push({ pathname: "/box/[id]", params: { id: box.id } })}
          />
        ))}
      </Card>
      {editable ? (
        <View style={{ marginBottom: spacing.lg }}>
          <Button label={tr.product.addBox} icon={Plus} variant="secondary" onPress={() => router.push({ pathname: "/add-box", params: { product: product.id } })} />
        </View>
      ) : null}

      <ProductPlans productId={product.id} editable={editable} />
      <LinkedDocuments target={{ product: product.id }} editable={editable} />

      {editable ? (
        <>
          <SectionHeader>{tr.product.tagsSection}</SectionHeader>
          {tags.length > 0 ? (
            <Card rows>
              {tags.map((tag) => {
                const on = product.tagIds.includes(tag.id);
                return <ListRow key={tag.id} icon={Tag} title={tag.name} selected={on} onPress={() => void attempt(() => tagProduct(product.id, tag.id, !on))} />;
              })}
            </Card>
          ) : null}
          <View style={{ alignItems: "flex-start", marginBottom: spacing.lg }}>
            <Button label={tr.names.add.tags} icon={TagPlus} variant="ghost" size="sm" onPress={() => void addTag()} />
          </View>
        </>
      ) : (
        <ReadTags tags={tags.filter((tag) => product.tagIds.includes(tag.id))} />
      )}

      <PhotoField name={product.name} photoId={product.photoId} thumb={product.thumb} onChange={changing((photo: NewPhoto | null) => void attempt(() => setPhoto("products", product.id, photo)))} />

      <SectionHeader>{tr.product.detailsSection}</SectionHeader>
      <Card rows>
        {FIELDS.map(([field, label, maxLength]) => (
          <ListRow key={field} title={label} subtitle={product[field] ?? tr.box.unknown} chevron={editable} onPress={changing(() => void change(field, label, maxLength))} />
        ))}
        {product.gtin ? <ListRow title={tr.addBox.barcode} subtitle={printedGtin(product.gtin)} /> : null}
        <ListRow title={tr.product.note} subtitle={product.note ?? tr.product.noteEmpty} chevron={editable} onPress={changing(() => void change("note", tr.product.note, 2000))} />
      </Card>
    </Screen>
  );
}

/** Read, a product's tags are the ones it has: every tag is listed only to be put on. */
function ReadTags({ tags }: { tags: readonly Named[] }) {
  if (tags.length === 0) return null;
  return (
    <>
      <SectionHeader>{tr.product.tagsSection}</SectionHeader>
      <Card rows>
        {tags.map((tag) => (
          <ListRow key={tag.id} icon={Tag} title={tag.name} />
        ))}
      </Card>
    </>
  );
}
