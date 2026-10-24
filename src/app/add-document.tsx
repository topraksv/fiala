/**
 * Adding a document (`docs/TASKS.md` F3.2, F3.3, F3.5): its file — a photo
 * taken or chosen, or a PDF — its kind, and what is written on it. It goes to
 * the household open, as a box does (F0.3), after saying the household will
 * read it; "Özel" keeps it to the person. From a box's or a product's page it
 * is linked to it as it is saved.
 */

import { useState } from "react";
import { Image, Platform, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import Camera from "lucide-react-native/icons/camera";
import FileText from "lucide-react-native/icons/file-text";
import ImagePlus from "lucide-react-native/icons/image-plus";
import Save from "lucide-react-native/icons/save";
import X from "lucide-react-native/icons/x";
import type { LucideIcon } from "lucide-react-native";

import { addNamed } from "../data/cabinet";
import { addDocument, byteSizeOf, DOCUMENT_BYTES, fileTypeOf, type NewDocumentFile } from "../data/documents";
import { usePeople, useSettings } from "../data/hooks";
import { giveHealthConsent, hasHealthConsent, profileChoice } from "../data/settings";
import type { DocumentKind } from "../db/schema";
import { parseDay } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { readPickedBytes, UserFacingError } from "../services/picked-file";
import { base64Of } from "../sync/photos";
import { Body, Button, Card, IconButton, ListRow, Notice, Screen, SectionHeader, TextField } from "../ui/components";
import { KINDS, Tiles } from "../ui/documents";
import { appConfirm, appError } from "../ui/dialog";
import { useDirtyExitGuard } from "../ui/dirty-exit";
import { CabinetChoice, NamedChoices, useCabinetChoice } from "../ui/named-choices";
import { navigateBack } from "../ui/navigation";
import { Source } from "../ui/photo-field";
import { photoPreview, radius, spacing, useTheme } from "../ui/theme";
import { showNotice } from "../ui/undo";

/** A page's print still reads at this edge, and the file stays far below Storage's 10 MB. */
const DOCUMENT_EDGE = 2000;

const EMPTY = { title: "", issued: "", reference: "", note: "" };
type Fields = typeof EMPTY;
/** What the server holds at most (migration 14). */
const MAX: Readonly<Record<keyof Fields, number>> = { title: 120, issued: 10, reference: 40, note: 2000 };

const orNull = (text: string) => text.trim() || null;

type Take = () => Promise<NewDocumentFile | "cancelled" | "denied">;

async function photoFile(from: "camera" | "library"): Promise<NewDocumentFile | "cancelled" | "denied"> {
  const takePhoto = (await import("../ui/photo-take")).default;
  const taken = await takePhoto(from, DOCUMENT_EDGE);
  if (typeof taken === "string") return taken;
  return { base64: taken.data.slice(taken.data.indexOf(",") + 1), type: "jpeg" };
}

async function pdfFile(): Promise<NewDocumentFile | "cancelled"> {
  const picked = await DocumentPicker.getDocumentAsync({ type: ["application/pdf"], copyToCacheDirectory: true });
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return "cancelled";
  const base64 = base64Of(await readPickedBytes(asset, DOCUMENT_BYTES, tr.documents.tooLarge));
  // What the picker calls a PDF is kept only when its bytes say so.
  if (fileTypeOf(base64) !== "pdf") throw new UserFacingError(tr.documents.unreadable);
  return { base64, type: "pdf" };
}

export default function AddDocumentScreen() {
  const router = useRouter();
  const { package: packageId, product: productId } = useLocalSearchParams<{ package?: string; product?: string }>();
  const { palette } = useTheme();
  const target = useCabinetChoice();
  const cabinetId = target.cabinetId;
  const settings = useSettings();
  const people = usePeople().data.filter((each) => each.cabinetId === cabinetId);
  const [file, setFile] = useState<NewDocumentFile | null>(null);
  const [kind, setKind] = useState<DocumentKind>("prescription");
  const [fields, setFields] = useState(EMPTY);
  const [personChoice, setPersonId] = useState<string | null>();
  const personId = personChoice === undefined ? profileChoice(settings.data, "owner", cabinetId, people) : personChoice;
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const { allowExit } = useDirtyExitGuard(file != null || Object.values(fields).some((value) => value.trim() !== ""));
  const errors = {
    file: file ? null : tr.documents.fileMissing,
    issued: fields.issued.trim() && !parseDay(fields.issued) ? tr.addBox.dayInvalid : null,
  };

  const chooseOwn = (to: boolean) => {
    target.setOwn(to);
    setPersonId(undefined);
  };

  const take = async (pick: Take) => {
    setFailure(null);
    try {
      const picked = await pick();
      if (picked === "denied") return void appError(tr.photos.denied);
      if (picked !== "cancelled") setFile(picked);
    } catch (error) {
      setFailure(error instanceof UserFacingError ? error.message : tr.documents.unreadable);
    }
  };
  // A phone's browser offers its camera from the file picker itself, as a photo's field says.
  const sources: (readonly [LucideIcon, string, Take])[] = [
    ...(Platform.OS === "web"
      ? [[ImagePlus, tr.documents.image, () => photoFile("library")] as const]
      : [[Camera, tr.documents.camera, () => photoFile("camera")] as const, [ImagePlus, tr.documents.library, () => photoFile("library")] as const]),
    [FileText, tr.documents.pdf, pdfFile],
  ];

  const save = async () => {
    setAttempted(true);
    setFailure(null);
    if (!cabinetId || !file || Object.values(errors).some((error) => error != null)) return;
    if (!hasHealthConsent(settings.data)) {
      if (!(await appConfirm(tr.addBox.consentTitle, tr.addBox.consentBody, tr.addBox.consentConfirm))) return setFailure(tr.addBox.consentRequired);
      await giveHealthConsent();
    }
    if (!target.own && target.open && !(await appConfirm(tr.documents.shareTitle, tr.documents.shareBody(target.open.name), tr.documents.shareConfirm))) return;
    setBusy(true);
    try {
      await addDocument(
        cabinetId,
        { kind, title: fields.title.trim(), personId, issuedOn: fields.issued.trim() ? parseDay(fields.issued) : null, note: orNull(fields.note), reference: orNull(fields.reference) },
        file,
        packageId ? { packageId } : productId ? { productId } : undefined,
      );
      showNotice(tr.documents.saved);
      allowExit(() => navigateBack(router, "/documents"));
    } catch {
      setFailure(tr.documents.failed);
    }
    setBusy(false);
  };

  const field = (key: keyof Fields, label: string, props: Partial<Parameters<typeof TextField>[0]> = {}) => (
    <TextField
      label={label}
      value={fields[key]}
      onChangeText={(text) => setFields((current) => ({ ...current, [key]: text }))}
      maxLength={MAX[key]}
      error={attempted ? (errors as Partial<Record<keyof Fields, string | null>>)[key] : null}
      style={{ marginBottom: spacing.md }}
      {...props}
    />
  );

  return (
    <Screen back="/documents" title={tr.documents.add} width="form">
      <CabinetChoice household={target.open} own={target.own} onChoose={chooseOwn} title={tr.documents.targetSection} />

      <SectionHeader>{tr.documents.fileSection}</SectionHeader>
      {file?.type === "jpeg" ? (
        <View style={{ marginBottom: spacing.md }}>
          <Image
            source={{ uri: `data:image/jpeg;base64,${file.base64}` }}
            accessibilityLabel={tr.documents.imageOf(tr.documents.size(byteSizeOf(file.base64)))}
            resizeMode="contain"
            style={{ width: "100%", height: photoPreview.height, borderRadius: radius.md, backgroundColor: palette.surfaceAlt }}
          />
          <View style={{ position: "absolute", top: spacing.xs, right: spacing.xs }}>
            <IconButton icon={X} label={tr.documents.removeFile} onPress={() => setFile(null)} />
          </View>
        </View>
      ) : file ? (
        <Card rows>
          <ListRow icon={FileText} title={tr.documents.pdfOf(tr.documents.size(byteSizeOf(file.base64)))} right={<IconButton icon={X} label={tr.documents.removeFile} onPress={() => setFile(null)} />} />
        </Card>
      ) : (
        <>
          <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md }}>
            {sources.map(([icon, label, pick]) => (
              <Source key={label} icon={icon} label={label} onPress={() => void take(pick)} />
            ))}
          </View>
          {attempted && errors.file ? <Notice tone="error" text={errors.file} /> : null}
        </>
      )}

      <SectionHeader>{tr.documents.kindSection}</SectionHeader>
      <Tiles label={tr.documents.kindSection} options={KINDS} chosen={kind} onChoose={setKind} />

      {field("title", tr.documents.titleLabel, { examples: tr.documents.titleExamples })}
      {field("issued", tr.documents.issuedOn, { placeholder: tr.placeholders.opened, keyboardType: "numbers-and-punctuation" })}
      <Body muted style={{ marginBottom: spacing.md }}>{tr.documents.issuedHint}</Body>
      {field("reference", tr.documents.reference, { examples: tr.documents.referenceExamples, autoCapitalize: "characters" })}
      {field("note", tr.documents.note, { examples: tr.documents.noteExamples, multiline: true })}

      <NamedChoices
        table="people"
        title={tr.documents.whoseSection}
        named={people}
        chosen={personId}
        onChoose={setPersonId}
        onAdd={async (name) => cabinetId && setPersonId(await addNamed("people", cabinetId, name))}
      />

      {failure ? <Notice tone="error" text={failure} /> : null}
      <View style={{ alignItems: "flex-start", marginVertical: spacing.lg }}>
        <Button label={tr.legal.open} variant="ghost" size="sm" onPress={() => router.push("/privacy")} />
      </View>
      <Button label={busy ? tr.documents.saving : tr.documents.save} icon={Save} loading={busy} disabled={busy} onPress={() => void save()} />
    </Screen>
  );
}
