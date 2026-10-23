/**
 * Boxes from a file (`docs/TASKS.md` F1.13): a CSV or JSON is read on the
 * device, each row shown as the box it makes; a row with a field the cabinet
 * cannot take is fixed here, a box the cabinet or the file already holds is
 * set apart, and the rest are added in one write the undo bar takes back.
 */

import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import FileUp from "lucide-react-native/icons/file-up";
import Package from "lucide-react-native/icons/package";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";

import { useSession } from "../auth/session";
import { hasBox, importBoxes } from "../data/cabinet";
import { useSettings } from "../data/hooks";
import { giveHealthConsent, hasHealthConsent } from "../data/settings";
import { PACKAGE_UNITS } from "../db/schema";
import { undoRows } from "../db/mutations";
import { formatAmount, formatDay } from "../domain/boxes";
import { checkImportRow, readImportFile, repeatedInFile, type ImportField, type ImportRaw } from "../domain/import";
import { tr } from "../i18n/tr";
import { readPickedText, UserFacingError } from "../services/picked-file";
import { Body, Button, Card, ListRow, Notice, Screen, SectionHeader } from "../ui/components";
import { appConfirm, appPrompt } from "../ui/dialog";
import { navigateBack } from "../ui/navigation";
import { spacing } from "../ui/theme";
import { showUndo } from "../ui/undo";

const MAX_BYTES = 2_000_000;
/** Rows shown of those ready: past this the list is the file again, and the count says the rest. */
const SHOWN = 50;
const LINE_OFFSET = 2; // the header is line 1

const check = (raw: ImportRaw) => checkImportRow(raw, PACKAGE_UNITS);
const problemOf = (field: ImportField) =>
  field in tr.importFile.problems ? tr.importFile.problems[field as keyof typeof tr.importFile.problems] : tr.importFile.problems.tooLong;

/** Which rows are a box the cabinet holds already, by GTIN and serial. */
async function heldRows(raws: readonly ImportRaw[]): Promise<Set<number>> {
  const held = new Set<number>();
  for (const [at, raw] of raws.entries()) {
    const box = check(raw).box;
    if (box?.product.gtin && box.box.serial && (await hasBox(box.product.gtin, box.box.serial))) held.add(at);
  }
  return held;
}

export default function ImportScreen() {
  const router = useRouter();
  const cabinetId = useSession((s) => s.userId);
  const settings = useSettings();
  const [file, setFile] = useState<{ name: string; ignored: string[] } | null>(null);
  const [raws, setRaws] = useState<ImportRaw[]>([]);
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const [withHeld, setWithHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const checks = raws.map(check);
  const repeated = repeatedInFile(checks.map((each) => each.box));
  const rows = checks.map((each, at) => ({ at, line: at + LINE_OFFSET, name: raws[at]?.name?.trim() || "—", ...each, repeated: repeated[at], held: held.has(at) }));
  const broken = rows.filter((row) => !row.box);
  const doubled = rows.filter((row) => row.box && (row.repeated || row.held));
  const ready = rows.filter((row) => row.box && !row.repeated && (withHeld || !row.held));

  const pick = async () => {
    setFailure(null);
    const picked = await DocumentPicker.getDocumentAsync({
      type: ["text/csv", "text/comma-separated-values", "text/tab-separated-values", "text/plain", "application/json"],
      copyToCacheDirectory: true,
    });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    try {
      const read = readImportFile(await readPickedText(asset, MAX_BYTES, tr.importFile.tooLarge, tr.importFile.notUtf8));
      if (!read.ok) return setFailure(tr.importFile.reasons[read.reason]);
      setHeld(await heldRows(read.rows));
      setRaws(read.rows);
      setFile({ name: asset.name, ignored: read.ignored });
      setWithHeld(false);
    } catch (error) {
      setFailure(error instanceof UserFacingError ? error.message : tr.importFile.readFailed);
    }
  };

  const fix = async (at: number, field: ImportField) => {
    const typed = await appPrompt(tr.importFile.fields[field], problemOf(field), { confirmLabel: tr.common.save, initialValue: raws[at]?.[field] ?? "", maxLength: 2000 });
    if (typed == null) return;
    const next = raws.map((raw, each) => (each === at ? { ...raw, [field]: typed } : raw));
    setRaws(next);
    try {
      setHeld(await heldRows(next));
    } catch {
      setFailure(tr.importFile.readFailed);
    }
  };

  const save = async () => {
    if (!cabinetId || ready.length === 0) return;
    setFailure(null);
    if (!hasHealthConsent(settings.data)) {
      if (!(await appConfirm(tr.addBox.consentTitle, tr.addBox.consentBody, tr.addBox.consentConfirm))) return setFailure(tr.addBox.consentRequired);
      await giveHealthConsent();
    }
    setBusy(true);
    try {
      const written = await importBoxes(cabinetId, ready.map((row) => row.box!));
      navigateBack(router, "/cabinet");
      if (written) showUndo(tr.importFile.done(ready.length), () => undoRows(written));
    } catch {
      setFailure(tr.addBox.failed);
    }
    setBusy(false);
  };

  return (
    <Screen back="/cabinet" title={tr.importFile.title} width="form">
      <Body muted style={{ marginBottom: spacing.md }}>{tr.importFile.hint}</Body>
      <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
        <Button label={file ? tr.importFile.pickAnother : tr.importFile.pick} icon={FileUp} variant={file ? "ghost" : "secondary"} onPress={() => void pick()} />
      </View>
      {failure ? <Notice tone="error" text={failure} /> : null}
      {file ? (
        <>
          <Card rows>
            <ListRow title={file.name} subtitle={tr.importFile.summary(ready.length, broken.length, doubled.length)} />
            {file.ignored.length > 0 ? <ListRow title={tr.importFile.ignored(file.ignored.join(", "))} /> : null}
          </Card>

          {broken.length > 0 ? (
            <>
              <SectionHeader>{tr.importFile.brokenSection(broken.length)}</SectionHeader>
              <Body muted style={{ marginBottom: spacing.sm }}>{tr.importFile.brokenHint}</Body>
              <Card rows>
                {broken.map((row) => (
                  <ListRow
                    key={row.at}
                    icon={TriangleAlert}
                    title={tr.importFile.line(row.line, row.name)}
                    subtitle={row.problems.map((field) => `${tr.importFile.fields[field]}: ${problemOf(field)}`).join("\n")}
                    chevron
                    onPress={() => void fix(row.at, row.problems[0]!)}
                  />
                ))}
              </Card>
            </>
          ) : null}

          {doubled.length > 0 ? (
            <>
              <SectionHeader>{tr.importFile.heldSection(doubled.length)}</SectionHeader>
              <Card rows>
                {doubled.map((row) => (
                  <ListRow key={row.at} icon={Package} title={tr.importFile.line(row.line, row.name)} subtitle={row.repeated ? tr.importFile.repeated : tr.importFile.inCabinet} />
                ))}
              </Card>
              {doubled.some((row) => row.held && !row.repeated) ? (
                <View style={{ alignItems: "flex-start", marginBottom: spacing.md }}>
                  <Button label={withHeld ? tr.importFile.skipHeld : tr.importFile.addHeld} variant="ghost" size="sm" onPress={() => setWithHeld(!withHeld)} />
                </View>
              ) : null}
            </>
          ) : null}

          <SectionHeader>{tr.importFile.readySection(ready.length)}</SectionHeader>
          {ready.length > 0 ? (
            <Card rows>
              {ready.slice(0, SHOWN).map(({ at, box }) => (
                <ListRow
                  key={at}
                  icon={Package}
                  title={tr.common.joined(box!.product.name, box!.product.strength ?? undefined)}
                  subtitle={tr.common.joined(
                    box!.box.expiresOn ? tr.cabinet.expires(formatDay(box!.box.expiresOn)) : tr.cabinet.noExpiry,
                    box!.amountMilli > 0 ? tr.cabinet.remaining(formatAmount(box!.amountMilli), tr.units[box!.box.unit]) : tr.cabinet.uncounted,
                    box!.person ?? undefined,
                    box!.place ?? undefined,
                  )}
                />
              ))}
            </Card>
          ) : null}
          {ready.length > SHOWN ? <Body muted style={{ marginBottom: spacing.md }}>{tr.importFile.more(ready.length - SHOWN)}</Body> : null}
          <Button label={busy ? tr.importFile.saving : tr.importFile.add(ready.length)} disabled={busy || ready.length === 0} onPress={() => void save()} />
        </>
      ) : null}
    </Screen>
  );
}
