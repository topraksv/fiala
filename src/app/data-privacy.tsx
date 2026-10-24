/**
 * Ayarlar → Veri ve Gizlilik (`docs/TASKS.md` F4.9): the inventory exported
 * with its personal columns hidden at will (F4.3), the backup and its
 * restore (F4.5), the way in from another app's file, who can open each
 * document, the device's permissions, and the reset.
 */

import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as Linking from "expo-linking";
import ArchiveRestore from "lucide-react-native/icons/archive-restore";
import Bell from "lucide-react-native/icons/bell";
import Camera from "lucide-react-native/icons/camera";
import DatabaseBackup from "lucide-react-native/icons/database-backup";
import Eraser from "lucide-react-native/icons/eraser";
import FileSpreadsheet from "lucide-react-native/icons/file-spreadsheet";
import FileText from "lucide-react-native/icons/file-text";
import FileUp from "lucide-react-native/icons/file-up";
import Image from "lucide-react-native/icons/image";
import MapPin from "lucide-react-native/icons/map-pin";
import Settings from "lucide-react-native/icons/settings";

import { useSession } from "../auth/session";
import { useCabinet, useDocuments, useHouseholds, useLocations, usePeople, useSettings } from "../data/hooks";
import { giveHealthConsent, hasHealthConsent } from "../data/settings";
import { formatDay, localDay } from "../domain/boxes";
import { tr } from "../i18n/tr";
import { shareDocument } from "../services/document-file";
import { buildBackupText, inventoryGrid, MAX_BACKUP_BYTES, PERSONAL_COLUMNS, readBackup, restoreBackup, workbookBytes, type PersonalColumn } from "../services/export-import";
import { readPickedText, UserFacingError } from "../services/picked-file";
import { syncNow } from "../sync/engine";
import { base64Of } from "../sync/photos";
import { Body, Button, Card, ListRow, Screen, SectionHeader, ToggleRow } from "../ui/components";
import { appConfirm, appError } from "../ui/dialog";
import { spacing } from "../ui/theme";
import { showNotice } from "../ui/undo";

/** A failure the person can act on says so; anything else is the generic one. */
const said = (error: unknown, fallback: string) => (error instanceof UserFacingError ? error.message : fallback);

export default function DataPrivacyScreen() {
  return (
    <Screen back="/settings" title={tr.dataPrivacy.title} width="form">
      <Inventory />
      <Backup />
      <Documents />
      {Platform.OS === "web" ? <Body muted style={{ marginBottom: spacing.md }}>{tr.dataPrivacy.webPermissions}</Body> : <Permissions />}
      <SectionHeader>{tr.dataPrivacy.resetSection}</SectionHeader>
      <Card rows>
        <ListRow icon={Eraser} title={tr.dataReset.title} subtitle={tr.dataReset.entryDescription} chevron onPress={() => router.push("/data-reset")} />
      </Card>
    </Screen>
  );
}

function Inventory() {
  const cabinet = useCabinet().data;
  const { households } = useHouseholds();
  const people = usePeople().data;
  const locations = useLocations().data;
  const [hidden, setHidden] = useState<ReadonlySet<PersonalColumn>>(new Set(PERSONAL_COLUMNS));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const grid = inventoryGrid(cabinet, {
      households: new Map(households.data.map((each) => [each.id, each.name])),
      people: new Map(people.map((each) => [each.id, each.name])),
      locations: new Map(locations.map((each) => [each.id, each.name])),
    }, hidden);
    if (grid.length === 1) return appError(tr.dataPrivacy.inventoryEmpty);
    setBusy(true);
    // No `finally`: the React Compiler does not lower one.
    await workbookBytes(grid)
      .then((bytes) => shareDocument(base64Of(bytes), "xlsx", tr.inventory.fileName(localDay())))
      .catch(() => appError(tr.errors.shareFailed));
    setBusy(false);
  };

  return (
    <>
      <SectionHeader>{tr.dataPrivacy.exportSection}</SectionHeader>
      <Body muted style={{ marginBottom: spacing.sm }}>{tr.dataPrivacy.inventoryHint}</Body>
      <Card rows>
        {PERSONAL_COLUMNS.map((column) => (
          <ToggleRow
            key={column}
            title={tr.dataPrivacy.hide[column]}
            value={hidden.has(column)}
            onValueChange={(on) => setHidden((was) => new Set(PERSONAL_COLUMNS.filter((each) => (each === column ? on : was.has(each)))))}
          />
        ))}
      </Card>
      <Button label={tr.dataPrivacy.inventory} icon={FileSpreadsheet} loading={busy} onPress={() => void save()} />
    </>
  );
}

function Backup() {
  const me = useSession((s) => s.userId);
  const settings = useSettings();
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);

  const backup = async () => {
    if (!me) return;
    setBusy("backup");
    await buildBackupText(me)
      .then((text) => shareDocument(base64Of(new TextEncoder().encode(text)), "json", tr.backup.fileName(localDay())))
      .catch((error: unknown) => appError(said(error, tr.errors.shareFailed)));
    setBusy(null);
  };

  const restore = async () => {
    if (!me) return;
    const picked = await DocumentPicker.getDocumentAsync({ type: ["application/json", "text/plain"], copyToCacheDirectory: true }).catch(() => null);
    const asset = picked && !picked.canceled ? picked.assets[0] : null;
    if (!asset) return;
    setBusy("restore");
    await restoreFrom(asset).catch((error: unknown) => appError(said(error, tr.errors.saveFailed)));
    setBusy(null);
  };

  /** Read, confirmed, consented to, then written; any refusal on the way is said by the caller. */
  const restoreFrom = async (asset: DocumentPicker.DocumentPickerAsset) => {
    const file = readBackup(await readPickedText(asset, MAX_BACKUP_BYTES, tr.backup.tooLarge, tr.backup.notUtf8));
    if (!(await appConfirm(tr.dataPrivacy.restoreTitle, tr.dataPrivacy.restoreBody(formatDay(localDay(new Date(file.exportedAt)))), tr.dataPrivacy.restoreConfirm))) return;
    // What a backup holds is health data, as a box added by hand is.
    if (!hasHealthConsent(settings.data)) {
      if (!(await appConfirm(tr.addBox.consentTitle, tr.addBox.consentBody, tr.addBox.consentConfirm))) return;
      await giveHealthConsent();
    }
    const done = await restoreBackup(me!, file, () => syncNow(me!));
    showNotice(tr.dataPrivacy.restored(done.restored, done.kept, done.closed));
  };

  return (
    <>
      <SectionHeader>{tr.dataPrivacy.backupSection}</SectionHeader>
      <Body muted style={{ marginBottom: spacing.sm }}>{tr.dataPrivacy.backupHint}</Body>
      <Card rows>
        <ListRow icon={DatabaseBackup} title={tr.dataPrivacy.backup} chevron onPress={busy ? undefined : () => void backup()} />
        <ListRow icon={ArchiveRestore} title={tr.dataPrivacy.restore} subtitle={tr.dataPrivacy.restoreHint} chevron onPress={busy ? undefined : () => void restore()} />
        <ListRow icon={FileUp} title={tr.dataPrivacy.importOther} subtitle={tr.dataPrivacy.importOtherHint} chevron onPress={() => router.push("/import")} />
      </Card>
    </>
  );
}

/** Who can open each document: the person's own cabinet, or a household's members (F3.5). */
function Documents() {
  const { me, households } = useHouseholds();
  const documents = useDocuments().data;
  const count = (cabinetId: string) => documents.filter((each) => each.cabinetId === cabinetId).length;
  const shared = households.data.filter((each) => count(each.id) > 0);
  return (
    <>
      <SectionHeader>{tr.dataPrivacy.documentsSection}</SectionHeader>
      <Card rows>
        <ListRow icon={FileText} title={tr.dataPrivacy.documentsOwn(me ? count(me) : 0)} chevron onPress={() => router.push("/documents")} />
        {shared.map((household) => (
          <ListRow key={household.id} icon={FileText} title={tr.dataPrivacy.documentsIn(household.name, count(household.id))} chevron onPress={() => router.push("/documents")} />
        ))}
      </Card>
      <Body muted style={{ marginBottom: spacing.md }}>{tr.dataPrivacy.documentsHint}</Body>
    </>
  );
}

type PermissionState = keyof typeof tr.dataPrivacy.permissionState;
type Permission = keyof typeof tr.dataPrivacy.permissions;

/** Asked, never requested: this page shows what the device answered, and the phone's Settings change it. */
async function readPermissions(): Promise<Record<Permission, PermissionState>> {
  const [ImagePicker, Location, Notifications] = await Promise.all([import("expo-image-picker"), import("expo-location"), import("expo-notifications")]);
  const [camera, location, notifications] = await Promise.all([ImagePicker.getCameraPermissionsAsync(), Location.getForegroundPermissionsAsync(), Notifications.getPermissionsAsync()]);
  const state = (answer: { granted: boolean; canAskAgain: boolean; status: string }): PermissionState => (answer.granted ? "granted" : answer.status === "undetermined" ? "undetermined" : "denied");
  return { camera: state(camera), location: state(location), notifications: state(notifications) };
}

function Permissions() {
  const [states, setStates] = useState<Record<Permission, PermissionState> | null>(null);
  // Read again on each return: the person may have just changed one in Settings.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      readPermissions().then(
        (read) => live && setStates(read),
        () => {},
      );
      return () => {
        live = false;
      };
    }, []),
  );
  const icons = { camera: Camera, location: MapPin, notifications: Bell } as const;
  return (
    <>
      <SectionHeader>{tr.dataPrivacy.permissionsSection}</SectionHeader>
      <Card rows>
        {(Object.keys(icons) as Permission[]).map((permission) => (
          <ListRow key={permission} icon={icons[permission]} title={tr.dataPrivacy.permissions[permission]} subtitle={states ? tr.dataPrivacy.permissionState[states[permission]] : undefined} />
        ))}
        <ListRow icon={Image} title={tr.dataPrivacy.photos} subtitle={tr.dataPrivacy.photosState} />
        <ListRow icon={Settings} title={tr.dataPrivacy.openSettings} subtitle={tr.dataPrivacy.permissionsHint} chevron onPress={() => void Linking.openSettings().catch(() => appError(tr.errors.openFailed))} />
      </Card>
    </>
  );
}
