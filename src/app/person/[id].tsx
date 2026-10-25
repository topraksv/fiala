/**
 * One person boxes are for (`docs/TASKS.md` F1.20): their name, the colour or
 * photo their boxes are told apart by, their own notice ahead of an expiry,
 * which their boxes take unless a box was given its own, and the allergies
 * and conditions their emergency card shows (F7.7).
 */

import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import HeartPulse from "lucide-react-native/icons/heart-pulse";
import Pill from "lucide-react-native/icons/pill";
import Trash from "lucide-react-native/icons/trash";

import { editPerson, renameNamed, setPhoto } from "../../data/cabinet";
import { useCabinet, useHouseholds, usePeople, useSettings } from "../../data/hooks";
import { giveHealthConsent, hasHealthConsent } from "../../data/settings";
import { PERSON_COLORS } from "../../db/schema";
import { deleteRows, undoRows } from "../../db/mutations";
import { parseDays, SOON_DAYS, WARN_DAYS_MAX } from "../../domain/boxes";
import { tr } from "../../i18n/tr";
import { Body, Card, ChoiceTile, IconButton, ListRow, Missing, rowsOf, Screen, SectionHeader, useTileColumns } from "../../ui/components";
import { appConfirm, appError, appPrompt } from "../../ui/dialog";
import { radioGroupKeys } from "../../ui/keys";
import { PersonMark, ViewOnly } from "../../ui/named-choices";
import { navigateBack } from "../../ui/navigation";
import { openCabinet } from "../../ui/cabinet-link";
import { PhotoField } from "../../ui/photo-field";
import { controlSize, personMark, spacing } from "../../ui/theme";
import { showUndo } from "../../ui/undo";

const COLORS = [null, ...PERSON_COLORS] as const;
// The server's bound on both columns (migration 19).
const HEALTH_MAX = 500;
// "self" is not chosen here: the profile says which person is the one using the app.
const KINDS = ["person", "pet"] as const;

export default function PersonScreen() {
  const columns = useTileColumns(3);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const people = usePeople();
  const settings = useSettings();
  const cabinet = useCabinet();
  const { writes } = useHouseholds();
  const person = people.data.find((each) => each.id === id);

  if (!person) {
    return (
      <Screen back="/names/people" title={tr.names.title.people}>
        <Missing query={people} text={tr.person.notFound} />
      </Screen>
    );
  }
  const boxes = cabinet.data.flatMap((product) => product.boxes).filter((box) => box.personId === person.id && box.disposition == null).length;

  const editable = writes(person.cabinetId);
  const attempt = async (write: () => Promise<unknown>) => {
    try {
      await write();
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };

  const rename = async () => {
    const name = (await appPrompt(tr.names.rename, "", { confirmLabel: tr.common.save, initialValue: person.name, maxLength: 80 }))?.trim();
    if (name && name !== person.name) await attempt(() => renameNamed("people", person.id, name));
  };

  const changeWarn = async () => {
    const typed = (await appPrompt(tr.box.warn, tr.person.warnHint, { confirmLabel: tr.common.save, kind: "amount", examples: ["7", "30", "90"], initialValue: person.warnDays?.toString() ?? "", maxLength: 3 }))?.trim();
    if (typed == null) return;
    const warnDays = typed ? parseDays(typed, WARN_DAYS_MAX) : null;
    if (typed && warnDays == null) return void appError(tr.box.warnInvalid);
    await attempt(() => editPerson(person.id, { warnDays }));
  };

  const changeHealth = async (field: "allergies" | "conditions") => {
    const typed = (await appPrompt(tr.person[field], tr.person[`${field}Hint`], { confirmLabel: tr.common.save, initialValue: person[field] ?? "", maxLength: HEALTH_MAX, multiline: true }))?.trim();
    if (typed == null || typed === (person[field] ?? "")) return;
    if (typed && !hasHealthConsent(settings.data)) {
      if (!(await appConfirm(tr.addBox.consentTitle, tr.addBox.consentBody, tr.addBox.consentConfirm))) return;
      await giveHealthConsent();
    }
    await attempt(() => editPerson(person.id, { [field]: typed || null }));
  };

  const remove = async () => {
    if (!(await appConfirm(tr.names.remove(person.name), tr.names.removeBody.people, tr.names.removeConfirm))) return;
    try {
      const written = await deleteRows("people", [person.id]);
      navigateBack(router, "/names/people");
      if (written) showUndo(tr.common.deleted(person.name), () => undoRows(written));
    } catch {
      await appError(tr.errors.deleteFailed);
    }
  };

  return (
    <Screen
      back="/names/people"
      title={person.name}
      actions={editable ? <IconButton icon={Trash} label={tr.common.joined(tr.names.removeConfirm, person.name)} tone="danger" onPress={() => void remove()} /> : null}
    >
      <ViewOnly cabinetId={person.cabinetId} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.md }}>
        <PersonMark person={person} size={personMark.large} />
        <Body muted>{tr.common.joined(person.kind === "pet" ? tr.person.kinds.pet : undefined, tr.person.boxes(boxes))}</Body>
      </View>

      <Card rows>
        <ListRow icon={Pill} title={tr.person.showBoxes} chevron onPress={() => openCabinet({ person: person.id })} />
        <ListRow icon={HeartPulse} title={tr.person.card} chevron onPress={() => router.push({ pathname: "/emergency/[id]", params: { id: person.id } })} />
        <ListRow title={tr.person.name} subtitle={person.name} chevron={editable} onPress={editable ? () => void rename() : undefined} />
        <ListRow
          title={tr.box.warn}
          subtitle={person.warnDays == null ? tr.box.warnDefault(tr.box.warnBefore(SOON_DAYS)) : tr.box.warnBefore(person.warnDays)}
          chevron={editable}
          onPress={editable ? () => void changeWarn() : undefined}
        />
        {(["allergies", "conditions"] as const).map((field) => (
          <ListRow key={field} title={tr.person[field]} subtitle={person[field] ?? tr.person.none} chevron={editable} onPress={editable ? () => void changeHealth(field) : undefined} />
        ))}
      </Card>

      {editable ? (
        <>
          <SectionHeader>{tr.person.kindSection}</SectionHeader>
          <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.person.kindSection} style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm }}>
            {KINDS.map((kind) => (
              <ChoiceTile key={kind} label={tr.person.kinds[kind]} selected={person.kind === kind} layout="row" minHeight={controlSize.minimumTarget} onPress={() => void attempt(() => editPerson(person.id, { kind }))}>
                <PersonMark person={{ ...person, kind, thumb: null }} />
              </ChoiceTile>
            ))}
          </View>
          <SectionHeader>{tr.person.colorSection}</SectionHeader>
          <Body muted style={{ marginBottom: spacing.sm }}>{tr.person.colorHint}</Body>
          <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.person.colorSection} style={{ gap: spacing.sm, marginBottom: spacing.sm }}>
            {rowsOf(COLORS, columns).map((row, at) => (
              <View key={at} style={{ flexDirection: "row", gap: spacing.sm }}>
                {row.map((color) => (
                  <ChoiceTile
                    key={color ?? "auto"}
                    label={color ? tr.person.colors[color] : tr.person.colorAuto}
                    selected={person.color === color}
                    minHeight={controlSize.minimumTarget}
                    onPress={() => void attempt(() => editPerson(person.id, { color }))}
                  >
                    <PersonMark person={{ ...person, color, thumb: null }} />
                  </ChoiceTile>
                ))}
              </View>
            ))}
          </View>
        </>
      ) : null}

      <PhotoField name={person.name} photoId={person.photoId} thumb={person.thumb} onChange={editable ? (change) => void attempt(() => setPhoto("people", person.id, change)) : undefined} />
    </Screen>
  );
}
