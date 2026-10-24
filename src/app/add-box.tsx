/**
 * Adding a box (`docs/TASKS.md` F1.8, F1.7, F1.11, F1.12, F1.4). A scan fills
 * what the code carries and, from the cabinet's own product of that GTIN,
 * what the box does not, and else from TİTCK's list (F1.9); a name searched
 * in the list fills the same fields (F1.10). Every field stays the person's
 * to correct before saving. The first save asks the health-data consent, apart from the
 * notice accepted at sign-up.
 */

import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Save from "lucide-react-native/icons/save";
import FileUp from "lucide-react-native/icons/file-up";
import ScanLine from "lucide-react-native/icons/scan-line";

import { addNamed, addPackage, findProduct, hasBox, type PackageFields } from "../data/cabinet";
import { useCabinet, useLocations, usePeople, useSettings } from "../data/hooks";
import { giveHealthConsent, hasHealthConsent, profileChoice } from "../data/settings";
import { PACKAGE_UNITS } from "../db/schema";
import { catalogueFields, normalGtin, parseAmount, parseDay, printedGtin, readBoxCode } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { canScan, launchScanner, onScanned } from "../services/barcode-scan";
import { catalogueByGtin, catalogueEntry, type CatalogueEntry } from "../services/guide";
import { CatalogueRows, CatalogueSearch } from "../ui/catalogue";
import { Body, Button, ChoiceTile, Notice, Screen, SectionHeader, TextField, rowsOf, useTileColumns } from "../ui/components";
import { CabinetChoice, NamedChoices, useCabinetChoice } from "../ui/named-choices";
import { appConfirm } from "../ui/dialog";
import { useDirtyExitGuard } from "../ui/dirty-exit";
import { radioGroupKeys } from "../ui/keys";
import { navigateBack } from "../ui/navigation";
import { controlSize, spacing } from "../ui/theme";
import { showNotice } from "../ui/undo";

type Unit = PackageFields["unit"];

const EMPTY = {
  name: "",
  activeSubstance: "",
  strength: "",
  form: "",
  pack: "",
  brand: "",
  manufacturer: "",
  barcode: "",
  expiry: "",
  opened: "",
  amount: "",
  serial: "",
  lot: "",
};
type Fields = typeof EMPTY;

/** What the server holds at most, so a refusal is said here rather than set aside by sync. */
const MAX: Readonly<Record<keyof Fields, number>> = {
  name: 200,
  activeSubstance: 500,
  strength: 100,
  form: 100,
  pack: 100,
  brand: 200,
  manufacturer: 200,
  barcode: 14,
  expiry: 10,
  opened: 10,
  amount: 11,
  serial: 20,
  lot: 20,
};

const orNull = (text: string) => text.trim() || null;
const dayOrNull = (text: string) => (text.trim() ? parseDay(text) : null);

/** Each field's refusal, `null` where it can be saved as typed; a held product's fields are not asked. */
function refusals(fields: Fields, held: boolean) {
  return {
    name: held || fields.name.trim() ? null : tr.addBox.nameMissing,
    barcode: !held && fields.barcode.trim() && !normalGtin(fields.barcode) ? tr.addBox.barcodeInvalid : null,
    expiry: fields.expiry.trim() && !parseDay(fields.expiry) ? tr.addBox.dayInvalid : null,
    opened: fields.opened.trim() && !parseDay(fields.opened) ? tr.addBox.dayInvalid : null,
    amount: fields.amount.trim() && parseAmount(fields.amount) == null ? tr.addBox.amountInvalid : null,
  };
}

export default function AddBoxScreen() {
  const columns = useTileColumns(3);
  const router = useRouter();
  // From a product's page: another box of it, so only the box is asked. From Durum's scan button, the scanner opens at once.
  // From Rehber's medicine page: that entry of the list, picked as if chosen here.
  const { product: heldId, scan: scanFirst, search: searchFirst, listed: listedId } = useLocalSearchParams<{ product?: string; scan?: string; search?: string; listed?: string }>();
  const cabinet = useCabinet().data;
  const held = cabinet.find((product) => product.id === heldId);
  const target = useCabinetChoice();
  // Another box of a product goes where the product is.
  const cabinetId = held?.cabinetId ?? target.cabinetId;
  const settings = useSettings();
  const people = usePeople().data.filter((each) => each.cabinetId === cabinetId);
  const locations = useLocations().data.filter((each) => each.cabinetId === cabinetId);
  const [fields, setFields] = useState(EMPTY);
  const [unit, setUnit] = useState<Unit>("tablet");
  // Undefined until the form chooses: then the account's default (F1.28), while that person or place still exists.
  const [personChoice, setPersonId] = useState<string | null>();
  const [locationChoice, setLocationId] = useState<string | null>();
  const personId = personChoice === undefined ? profileChoice(settings.data, "owner", cabinetId, people) : personChoice;
  const locationId = locationChoice === undefined ? profileChoice(settings.data, "place", cabinetId, locations) : locationChoice;
  // A person or a place belongs to one cabinet: another cabinet starts again from its defaults.
  const chooseOwn = (to: boolean) => {
    target.setOwn(to);
    setPersonId(undefined);
    setLocationId(undefined);
  };
  const [scanNote, setScanNote] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  // A barcode the list gives two products: the person says which is in the box.
  const [choices, setChoices] = useState<CatalogueEntry[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Said only once a save is tried, so the form does not scold while typing.
  const [attempted, setAttempted] = useState(false);
  const errors = refusals(fields, held != null);
  const { allowExit } = useDirtyExitGuard(Object.values(fields).some((value) => value.trim() !== ""));

  const set = (key: keyof Fields) => (text: string) => setFields((current) => ({ ...current, [key]: text }));

  // A listed product fills the medicine's fields: chosen by name, over what was typed; found by a scan, only what is empty.
  const fillListed = (entry: CatalogueEntry, over: boolean) => {
    const { name, strength, form, pack } = catalogueFields(entry.name);
    const listed = { name, strength, form, pack, activeSubstance: entry.activeSubstance, manufacturer: entry.holder, barcode: entry.gtin && printedGtin(entry.gtin) };
    setFields((current) => {
      const filled = { ...current };
      for (const [key, value] of Object.entries(listed) as [keyof Fields, string | null][]) {
        if (value && (over || !filled[key].trim())) filled[key] = value;
      }
      return filled;
    });
    setChoices([]);
    setScanNote({ tone: "success", text: tr.catalogue.filled(name) });
  };

  // Chosen by name: a product already in this cabinet takes another box in one step.
  const pickListed = (entry: CatalogueEntry) => {
    const there = entry.gtin ? cabinet.find((product) => product.cabinetId === cabinetId && product.gtin === entry.gtin) : undefined;
    if (there) return router.replace({ pathname: "/add-box", params: { product: there.id } });
    fillListed(entry, true);
  };

  const fillFromList = async (gtin: string) => {
    const listed = await catalogueByGtin(gtin);
    if (listed?.length === 1) return fillListed(listed[0]!, false);
    if (listed && listed.length > 1) return setChoices(listed);
    setScanNote({ tone: "error", text: listed ? tr.addBox.unmatched : tr.catalogue.unreachable });
  };

  // The barcode found in the cabinet fills what is still empty, never what was typed; else the list does.
  const fillFrom = async (gtin: string) => {
    if (!cabinetId) return;
    setChoices([]);
    const known = await findProduct(cabinetId, gtin);
    if (!known) return fillFromList(gtin);
    setFields((current) => {
      const filled = { ...current };
      for (const key of ["name", "activeSubstance", "strength", "form", "pack", "brand", "manufacturer"] as const) {
        if (!filled[key].trim()) filled[key] = known[key] ?? "";
      }
      return filled;
    });
    setScanNote({ tone: "success", text: tr.addBox.matched(known.name) });
  };

  useEffect(
    () =>
      onScanned((data) => {
        const code = readBoxCode(data);
        if (!code) return setScanNote({ tone: "error", text: tr.addBox.unreadable });
        setFields((current) => ({
          ...current,
          barcode: heldId ? current.barcode : printedGtin(code.gtin),
          expiry: code.expiresOn ? code.expiresOn.split("-").reverse().join(".") : current.expiry,
          serial: code.serial ?? current.serial,
          lot: code.lot ?? current.lot,
        }));
        if (!heldId) void fillFrom(code.gtin);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one listener per cabinet and product: `fillFrom` reads nothing else that changes
    [cabinetId, heldId],
  );

  const scan = async () => {
    setScanNote(null);
    if (!(await launchScanner())) setScanNote({ tone: "error", text: tr.addBox.scanRefused });
  };

  // As the screen opens; the listener above is already there.
  useEffect(() => {
    if (scanFirst) void launchScanner().then((opened) => opened || setScanNote({ tone: "error", text: tr.addBox.scanRefused }));
  }, [scanFirst]);

  useEffect(() => {
    if (!listedId) return;
    void catalogueEntry(listedId).then((entry) => (entry ? pickListed(entry) : setScanNote({ tone: "error", text: entry === null ? tr.catalogue.unreachable : tr.medicine.notFound })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the screen opens: `pickListed` reads the cabinet as it is then
  }, [listedId]);

  const addChoice = async (table: "people" | "locations", name: string) => {
    if (!cabinetId) return;
    const id = await addNamed(table, cabinetId, name);
    (table === "people" ? setPersonId : setLocationId)(id);
  };

  const product = () =>
    held
      ? { id: held.id }
      : {
          name: fields.name.trim(),
          activeSubstance: orNull(fields.activeSubstance),
          strength: orNull(fields.strength),
          form: orNull(fields.form),
          pack: orNull(fields.pack),
          brand: orNull(fields.brand),
          manufacturer: orNull(fields.manufacturer),
          gtin: normalGtin(fields.barcode),
        };

  const save = async (next: boolean) => {
    setAttempted(true);
    setFailure(null);
    if (!cabinetId || Object.values(errors).some((error) => error != null)) return;
    if (!hasHealthConsent(settings.data)) {
      if (!(await appConfirm(tr.addBox.consentTitle, tr.addBox.consentBody, tr.addBox.consentConfirm))) return setFailure(tr.addBox.consentRequired);
      await giveHealthConsent();
    }
    const gtin = held ? held.gtin : normalGtin(fields.barcode);
    const serial = orNull(fields.serial);
    if (gtin && serial && (await hasBox(gtin, serial)) && !(await appConfirm(tr.addBox.duplicateTitle, tr.addBox.duplicateBody, tr.addBox.duplicateConfirm))) return;
    setBusy(true);
    try {
      const name = held?.name ?? fields.name.trim();
      await addPackage(
        cabinetId,
        product(),
        { unit, personId, locationId, expiresOn: dayOrNull(fields.expiry), openedOn: dayOrNull(fields.opened), serial, lot: orNull(fields.lot) },
        parseAmount(fields.amount) ?? 0,
      );
      showNotice(tr.addBox.saved(name));
      if (next) {
        setFields(EMPTY);
        setScanNote(null);
        setChoices([]);
        setAttempted(false);
      } else {
        allowExit(() => navigateBack(router, "/cabinet"));
      }
    } catch {
      setFailure(tr.addBox.failed);
    }
    setBusy(false);
  };

  const field = (key: keyof Fields, label: string, props: Partial<Parameters<typeof TextField>[0]> = {}) => (
    <TextField
      label={label}
      value={fields[key]}
      onChangeText={set(key)}
      maxLength={MAX[key]}
      error={attempted ? (errors as Partial<Record<keyof Fields, string | null>>)[key] : null}
      style={{ marginBottom: spacing.md }}
      {...props}
    />
  );

  return (
    <Screen back="/cabinet" title={tr.addBox.title} width="form">
      {canScan ? (
        <>
          <Body muted style={{ marginBottom: spacing.md }}>{tr.addBox.scanHint}</Body>
          <View style={{ marginBottom: spacing.md }}>
            <Button label={tr.addBox.scan} icon={ScanLine} variant="secondary" onPress={() => void scan()} />
          </View>
        </>
      ) : (
        <Body muted style={{ marginBottom: spacing.md }}>{tr.addBox.typeHint}</Body>
      )}
      {held ? null : <CatalogueSearch autoFocus={searchFirst === "1"} onPick={pickListed} />}
      {scanNote ? <Notice tone={scanNote.tone} text={scanNote.text} /> : null}
      <CatalogueRows entries={choices} lead={tr.catalogue.several} onPick={(entry) => fillListed(entry, true)} />
      {held ? null : (
        <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
          <Button label={tr.importFile.title} icon={FileUp} variant="ghost" size="sm" onPress={() => router.push("/import")} />
        </View>
      )}

      <CabinetChoice household={held ? null : target.open} own={target.own} onChoose={chooseOwn} />

      <SectionHeader>{tr.addBox.medicineSection}</SectionHeader>
      {held ? (
        <Body style={{ marginBottom: spacing.md }}>{tr.common.joined(held.name, held.strength ?? undefined, held.form ?? undefined)}</Body>
      ) : (
        <>
          {field("name", tr.addBox.name, { examples: tr.placeholders.medicine })}
          {field("barcode", tr.addBox.barcode, {
            keyboardType: "number-pad",
            placeholder: tr.placeholders.barcode,
            onEndEditing: () => {
              const gtin = normalGtin(fields.barcode);
              if (gtin) void fillFrom(gtin);
            },
          })}
          {field("activeSubstance", tr.addBox.substance, { examples: tr.placeholders.substance, autoCapitalize: "none" })}
          {field("strength", tr.addBox.strength, { examples: tr.placeholders.strength, autoCapitalize: "none" })}
          {field("form", tr.addBox.form, { examples: tr.placeholders.form, autoCapitalize: "none" })}
          {field("pack", tr.addBox.pack, { examples: tr.placeholders.pack, autoCapitalize: "none" })}
          {field("brand", tr.addBox.brand, { examples: tr.placeholders.brand })}
          {field("manufacturer", tr.addBox.manufacturer, { examples: tr.placeholders.brand })}
        </>
      )}

      <SectionHeader>{tr.addBox.boxSection}</SectionHeader>
      {field("expiry", tr.addBox.expiry, { placeholder: tr.placeholders.expiry, keyboardType: "numbers-and-punctuation" })}
      {field("opened", tr.addBox.opened, { placeholder: tr.placeholders.opened, keyboardType: "numbers-and-punctuation" })}
      <Body muted style={{ marginBottom: spacing.md }}>{tr.addBox.dayHint}</Body>
      <SectionHeader>{tr.addBox.unit}</SectionHeader>
      <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.addBox.unit} style={{ gap: spacing.sm, marginBottom: spacing.md }}>
        {rowsOf(PACKAGE_UNITS, columns).map((row, at) => (
          <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
            {row.map((value) => (
              <ChoiceTile key={value} label={tr.units[value]} selected={unit === value} minHeight={controlSize.minimumTarget} onPress={() => setUnit(value)} />
            ))}
          </View>
        ))}
      </View>
      {field("amount", tr.addBox.amount, { examples: tr.placeholders.amount, keyboardType: "decimal-pad" })}
      {field("serial", tr.addBox.serial, { placeholder: tr.placeholders.serial, autoCapitalize: "characters" })}
      {field("lot", tr.addBox.lot, { placeholder: tr.placeholders.lot, autoCapitalize: "characters" })}

      <NamedChoices table="people" named={people} chosen={personId} onChoose={setPersonId} onAdd={(name) => addChoice("people", name)} />
      <NamedChoices table="locations" named={locations} chosen={locationId} onChoose={setLocationId} onAdd={(name) => addChoice("locations", name)} />

      {failure ? <Notice tone="error" text={failure} /> : null}
      <View style={{ alignItems: "flex-start", marginBottom: spacing.lg }}>
        <Button label={tr.legal.open} variant="ghost" size="sm" onPress={() => router.push("/privacy")} />
      </View>
      <View style={{ gap: spacing.sm }}>
        <Button label={busy ? tr.addBox.saving : tr.addBox.save} icon={Save} loading={busy} disabled={busy} onPress={() => void save(false)} />
        <Button label={tr.addBox.saveAndNext} variant="secondary" disabled={busy} onPress={() => void save(true)} />
      </View>
    </Screen>
  );
}
