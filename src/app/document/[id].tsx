/**
 * One document (`docs/TASKS.md` F3.2–F3.5): its file opened, shared or
 * downloaded, a leaflet's read in its sections (F5.2); what is written on it, each field saved as it is chosen, as on
 * a box's page; the medicines and boxes it is linked to; who sees it; and its
 * archive and deletion, each with an undo. Its file reaches the device when it
 * is first opened here (`fetchDocumentFile`), a photo's as the page opens.
 */

import { useEffect, useState } from "react";
import { Image, Platform, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Archive from "lucide-react-native/icons/archive";
import BookOpen from "lucide-react-native/icons/book-open";
import ArchiveRestore from "lucide-react-native/icons/archive-restore";
import Download from "lucide-react-native/icons/download";
import ExternalLink from "lucide-react-native/icons/external-link";
import FileText from "lucide-react-native/icons/file-text";
import Link from "lucide-react-native/icons/link";
import Package from "lucide-react-native/icons/package";
import Pill from "lucide-react-native/icons/pill";
import Share from "lucide-react-native/icons/share";
import Trash from "lucide-react-native/icons/trash";
import Unlink from "lucide-react-native/icons/unlink";

import { addNamed } from "../../data/cabinet";
import { archiveDocuments, deleteDocuments, editDocument, linkDocument, movableBy, moveDocument, type CabinetDocument, type DocumentFields } from "../../data/documents";
import { useCabinet, useDocuments, useHouseholds, usePeople } from "../../data/hooks";
import { undoRows } from "../../db/mutations";
import { formatDay, matchesSearch, parseDay } from "../../domain/boxes";
import { leafletOf, type Leaflet } from "../../domain/leaflet";
import { tr } from "../../i18n/tr";
import { openingTab, shareDocument, showPdf } from "../../services/document-file";
import { fetchDocumentFile } from "../../sync/documents";
import { bytesOf } from "../../sync/photos";
import { Body, Button, Card, IconButton, ListRow, Missing, Screen, SectionHeader, TextField } from "../../ui/components";
import { appConfirm, appError, appPrompt } from "../../ui/dialog";
import { documentTitle, KINDS, LeafletSections, Tiles } from "../../ui/documents";
import { CabinetChoice, NamedChoices, ViewOnly } from "../../ui/named-choices";
import { navigateBack } from "../../ui/navigation";
import { PhotoViewer } from "../../ui/photo-viewer";
import { Press } from "../../ui/press";
import { photoPreview, radius, spacing, useTheme } from "../../ui/theme";
import { showUndo } from "../../ui/undo";

/** A PDF's leaflet sections, or none. The reader and its inflater are loaded on the tap, out of every other page's bytes. */
async function leafletIn(base64: string): Promise<Leaflet | null> {
  const { extractPdfText } = await import("../../services/pdf-text");
  const text = await extractPdfText(bytesOf(base64));
  return text.ok ? leafletOf(text.text) : null;
}

/** Matches offered at once while linking: a search narrows the rest. */
const LINK_OFFERS = 8;

/** Every write here is one tap; a failure says so rather than leaving the page as if it took. */
async function attempt(write: () => Promise<unknown>) {
  try {
    await write();
  } catch {
    await appError(tr.errors.saveFailed);
  }
}

export default function DocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const documents = useDocuments();
  const { writes } = useHouseholds();
  const document = documents.data.find((each) => each.id === id);

  if (!document) {
    return (
      <Screen back="/documents" title={tr.documents.title}>
        <Missing query={documents} text={tr.documents.notFound} />
      </Screen>
    );
  }
  const editable = writes(document.cabinetId);
  const title = documentTitle(document);

  const archive = () =>
    attempt(async () => {
      const written = await archiveDocuments([document.id], !document.archived);
      if (!document.archived) showUndo(tr.documents.archived, () => undoRows(written));
    });

  const remove = async () => {
    if (!(await appConfirm(tr.documents.deleteTitle, tr.documents.deleteBody, tr.documents.delete))) return;
    try {
      const written = await deleteDocuments([document.id]);
      navigateBack(router, "/documents");
      if (written) showUndo(tr.documents.deleted, () => undoRows(written));
    } catch {
      await appError(tr.errors.deleteFailed);
    }
  };

  return (
    <Screen back="/documents" title={title} actions={editable ? <IconButton icon={Trash} label={tr.documents.delete} tone="danger" onPress={() => void remove()} /> : undefined}>
      <ViewOnly cabinetId={document.cabinetId} />
      {document.archived ? <Body muted style={{ marginBottom: spacing.md }}>{tr.documents.inArchive}</Body> : null}
      <FileCard document={document} title={title} />
      <Details document={document} editable={editable} />
      <Links document={document} editable={editable} />
      {editable ? (
        <>
          <Placement document={document} />
          <View style={{ alignItems: "flex-start", marginVertical: spacing.lg }}>
            <Button
              label={document.archived ? tr.documents.unarchive : tr.documents.archive}
              icon={document.archived ? ArchiveRestore : Archive}
              variant="secondary"
              onPress={() => void archive()}
            />
          </View>
        </>
      ) : null}
    </Screen>
  );
}

/** Its kind, what is written on it and whose it is; read, the same as rows. */
function Details({ document, editable }: { document: CabinetDocument; editable: boolean }) {
  const people = usePeople().data;

  /** Ask for one field and save it; emptied, it is no longer known. */
  const change = async (field: "title" | "issuedOn" | "reference" | "note", label: string, options: Omit<Parameters<typeof appPrompt>[2], "confirmLabel">, message = "") => {
    const typed = (await appPrompt(tr.box.changeTitle(label), message, { confirmLabel: tr.common.save, ...options }))?.trim();
    if (typed == null) return;
    const value = field === "issuedOn" && typed ? parseDay(typed) : typed || null;
    if (typed && value == null) return void appError(tr.addBox.dayInvalid);
    await attempt(() => editDocument(document.id, { [field]: field === "title" ? (value ?? "") : value } as Partial<DocumentFields>));
  };

  const details: [string, string, () => void][] = [
    [tr.documents.titleLabel, document.title || tr.box.unknown, () => void change("title", tr.documents.titleLabel, { examples: tr.documents.titleExamples, initialValue: document.title, maxLength: 120 })],
    [
      tr.documents.issuedOn,
      document.issuedOn ? formatDay(document.issuedOn) : tr.box.unknown,
      () => void change("issuedOn", tr.documents.issuedOn, { kind: "day", initialValue: document.issuedOn ? formatDay(document.issuedOn) : "", maxLength: 10 }, tr.documents.issuedHint),
    ],
    [tr.documents.reference, document.reference ?? tr.box.unknown, () => void change("reference", tr.documents.reference, { examples: tr.documents.referenceExamples, initialValue: document.reference ?? "", maxLength: 40 })],
    [tr.documents.note, document.note ?? tr.box.unknown, () => void change("note", tr.documents.note, { examples: tr.documents.noteExamples, initialValue: document.note ?? "", multiline: true, maxLength: 2000 })],
  ];

  if (!editable) {
    return (
      <>
        <SectionHeader>{tr.product.detailsSection}</SectionHeader>
        <Card rows>
          <ListRow title={tr.documents.kindSection} subtitle={tr.documents.kinds[document.kind]} />
          {details.map(([label, value]) => (
            <ListRow key={label} title={label} subtitle={value} />
          ))}
          <ListRow title={tr.documents.whoseSection} subtitle={people.find((person) => person.id === document.personId)?.name ?? tr.cabinet.unassigned} />
        </Card>
      </>
    );
  }
  return (
    <>
      <SectionHeader>{tr.documents.kindSection}</SectionHeader>
      <Tiles label={tr.documents.kindSection} options={KINDS} chosen={document.kind} onChoose={(kind) => void attempt(() => editDocument(document.id, { kind }))} />
      <SectionHeader>{tr.product.detailsSection}</SectionHeader>
      <Card rows>
        {details.map(([label, value, onPress]) => (
          <ListRow key={label} title={label} subtitle={value} chevron onPress={onPress} />
        ))}
      </Card>
      <NamedChoices
        table="people"
        title={tr.documents.whoseSection}
        named={people.filter((person) => person.cabinetId === document.cabinetId)}
        chosen={document.personId}
        onChoose={(personId) => void attempt(() => editDocument(document.id, { personId }))}
        onAdd={async (name) => editDocument(document.id, { personId: await addNamed("people", document.cabinetId, name) })}
      />
    </>
  );
}

/** The file: a photo drawn and enlarged, a PDF named by its size; opened, and shared or downloaded. */
function FileCard({ document, title }: { document: CabinetDocument; title: string }) {
  const { palette } = useTheme();
  const { fileId, fileType } = document;
  const [image, setImage] = useState<{ id: string; data: string } | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [leaflet, setLeaflet] = useState<{ id: string; read: Leaflet | null } | null>(null);
  // A photo is fetched as the page opens, to be drawn; a PDF waits for its tap.
  useEffect(() => {
    if (!fileId || fileType !== "jpeg") return;
    let live = true;
    fetchDocumentFile(fileId, fileType).then(
      (data) => live && data && setImage({ id: fileId, data }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [fileId, fileType]);
  if (!fileId || !fileType) return <Body muted style={{ marginBottom: spacing.md }}>{tr.documents.noFile}</Body>;
  const shown = image?.id === fileId ? image.data : null;

  const read = async (): Promise<string | null> => {
    try {
      const data = shown ?? (await fetchDocumentFile(fileId, fileType));
      if (!data) await appError(tr.documents.fileNotHere);
      return data;
    } catch {
      await appError(tr.documents.fileFailed);
      return null;
    }
  };
  const open = async () => {
    if (fileType === "jpeg") {
      const data = await read();
      if (data) {
        setImage({ id: fileId, data });
        setEnlarged(true);
      }
      return;
    }
    // Opened by the tap itself, or the browser refuses it once the file is read.
    const tab = openingTab();
    const data = await read();
    if (!data) return tab?.close();
    await showPdf(tab, data, title).catch(() => appError(tr.documents.fileFailed));
  };
  const readLeaflet = async () => {
    const data = await read();
    if (data) setLeaflet({ id: fileId, read: await leafletIn(data) });
  };
  const share = async () => {
    const data = await read();
    if (data) await shareDocument(data, fileType, title).catch(() => appError(tr.documents.fileFailed));
  };
  const web = Platform.OS === "web";

  return (
    <View style={{ gap: spacing.sm, marginBottom: spacing.md }}>
      {shown ? (
        <Press accessibilityRole="button" accessibilityLabel={tr.common.withDetail(tr.documents.open, title)} onPress={() => setEnlarged(true)}>
          <Image
            source={{ uri: `data:image/jpeg;base64,${shown}` }}
            accessible={false}
            resizeMode="contain"
            style={{ width: "100%", height: photoPreview.height, borderRadius: radius.md, backgroundColor: palette.surfaceAlt }}
          />
        </Press>
      ) : fileType === "pdf" ? (
        <Card rows>
          <ListRow icon={FileText} title={tr.documents.pdfOf(tr.documents.size(document.byteSize ?? 0))} />
        </Card>
      ) : null}
      {enlarged && shown ? <PhotoViewer uri={`data:image/jpeg;base64,${shown}`} label={title} onClose={() => setEnlarged(false)} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        <Button label={tr.documents.open} icon={ExternalLink} onPress={() => void open()} />
        <Button label={web ? tr.documents.download : tr.documents.share} icon={web ? Download : Share} variant="secondary" onPress={() => void share()} />
        {fileType === "pdf" ? <Button label={tr.documents.readLeaflet} icon={BookOpen} variant="secondary" onPress={() => void readLeaflet().catch(() => appError(tr.documents.fileFailed))} /> : null}
      </View>
      {leaflet?.id === fileId ? <LeafletSections leaflet={leaflet.read} /> : null}
    </View>
  );
}

/** What it is linked to, each taken off with one tap, and a search over the cabinet to link one more. */
function Links({ document, editable }: { document: CabinetDocument; editable: boolean }) {
  const router = useRouter();
  const cabinet = useCabinet().data;
  const { shows } = useHouseholds();
  const [linking, setLinking] = useState(false);
  const [query, setQuery] = useState("");
  const link = (target: { productId: string } | { packageId: string }, on: boolean) => linkDocument(document.id, target, on).catch(() => appError(tr.errors.saveFailed));
  const boxes = cabinet.flatMap((product) => product.boxes.map((box) => ({ box, product })));
  const linkedBoxes = boxes.filter(({ box }) => document.packageIds.includes(box.id));
  const linkedProducts = cabinet.filter((product) => document.productIds.includes(product.id));
  const boxLabel = (expiresOn: string | null) => (expiresOn ? tr.cabinet.expires(formatDay(expiresOn)) : tr.cabinet.noExpiry);
  const offers = cabinet
    .filter((product) => shows(product.cabinetId) && matchesSearch([product.name, product.brand, product.activeSubstance, product.strength], query))
    .slice(0, LINK_OFFERS);

  if (!editable && linkedBoxes.length + linkedProducts.length === 0) return null;
  return (
    <>
      <SectionHeader>{tr.documents.linksSection}</SectionHeader>
      {linkedBoxes.length + linkedProducts.length === 0 ? (
        <Body muted style={{ marginBottom: spacing.sm }}>{tr.documents.noLinks}</Body>
      ) : (
        <Card rows>
          {linkedProducts.map((product) => (
            <ListRow
              key={product.id}
              icon={Pill}
              title={tr.common.joined(product.name, product.strength ?? undefined)}
              onPress={() => router.push({ pathname: "/product/[id]", params: { id: product.id } })}
              right={editable ? <IconButton icon={Unlink} label={tr.documents.unlink(product.name)} onPress={() => void link({ productId: product.id }, false)} /> : undefined}
            />
          ))}
          {linkedBoxes.map(({ box, product }) => (
            <ListRow
              key={box.id}
              icon={Package}
              title={box.nickname ?? product.name}
              subtitle={boxLabel(box.expiresOn)}
              onPress={() => router.push({ pathname: "/box/[id]", params: { id: box.id } })}
              right={editable ? <IconButton icon={Unlink} label={tr.documents.unlink(box.nickname ?? product.name)} onPress={() => void link({ packageId: box.id }, false)} /> : undefined}
            />
          ))}
        </Card>
      )}
      {editable && !linking ? (
        <View style={{ alignItems: "flex-start", marginBottom: spacing.lg }}>
          <Button label={tr.documents.link} icon={Link} variant="ghost" size="sm" onPress={() => setLinking(true)} />
        </View>
      ) : null}
      {editable && linking ? (
        <>
          <TextField accessibilityLabel={tr.documents.linkSearch} value={query} onChangeText={setQuery} examples={tr.cabinet.searchExamples} autoCapitalize="none" autoCorrect={false} maxLength={80} style={{ marginBottom: spacing.sm }} />
          <Card rows>
            {offers.flatMap((product) => [
              <ListRow
                key={product.id}
                icon={Pill}
                title={tr.common.joined(product.name, product.strength ?? undefined)}
                selected={document.productIds.includes(product.id)}
                onPress={() => void link({ productId: product.id }, !document.productIds.includes(product.id))}
              />,
              ...product.boxes
                .filter((box) => box.disposition == null)
                .map((box) => (
                  <ListRow
                    key={box.id}
                    icon={Package}
                    title={box.nickname ?? product.name}
                    subtitle={boxLabel(box.expiresOn)}
                    selected={document.packageIds.includes(box.id)}
                    onPress={() => void link({ packageId: box.id }, !document.packageIds.includes(box.id))}
                  />
                )),
            ])}
          </Card>
        </>
      ) : null}
    </>
  );
}

/**
 * Who sees it (F3.5): the household it is in, or the open one for a document
 * of the person's own. Moved, it is a new row, so the page follows it to its
 * new id, and back on an undo. Only whoever added it moves it out (`movableBy`).
 */
function Placement({ document }: { document: CabinetDocument }) {
  const router = useRouter();
  const { me, open, households, writes } = useHouseholds();
  const household = households.data.find((each) => each.id === document.cabinetId) ?? (open && writes(open.id) ? open : null);
  if (!me || !household) return null;
  if (!movableBy(document, me)) {
    return (
      <>
        <SectionHeader>{tr.documents.seenBySection}</SectionHeader>
        <Body muted style={{ marginBottom: spacing.md }}>{tr.documents.onlyAdder}</Body>
      </>
    );
  }
  const own = document.cabinetId === me;
  const go = (id: string) => router.replace({ pathname: "/document/[id]", params: { id } });
  const choose = async (toOwn: boolean) => {
    if (toOwn === own) return;
    if (!toOwn && !(await appConfirm(tr.documents.shareTitle, tr.documents.shareBody(household.name), tr.documents.shareConfirm))) return;
    try {
      const moved = await moveDocument(document.id, toOwn ? me : household.id);
      if (!moved) return;
      go(moved.id);
      showUndo(toOwn ? tr.documents.movedPrivate : tr.documents.movedTo(household.name), async () => {
        await undoRows(moved.written);
        go(document.id);
      });
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };
  return <CabinetChoice household={household} own={own} title={tr.documents.seenBySection} onChoose={(toOwn) => void choose(toOwn)} />;
}
