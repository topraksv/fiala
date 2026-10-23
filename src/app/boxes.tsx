/**
 * The boxes chosen together in Dolabım (`docs/TASKS.md` F1.16): given to one
 * person or moved to one place, in one write the undo bar takes back whole.
 * Archiving and deleting them are on Dolabım's own header.
 */

import { useLocalSearchParams, useRouter } from "expo-router";

import { addNamed, editBoxes } from "../data/cabinet";
import { useCabinet, useLocations, usePeople } from "../data/hooks";
import { undoRows } from "../db/mutations";
import { tr } from "../i18n/tr";
import { Body, Screen } from "../ui/components";
import { appError } from "../ui/dialog";
import { NamedChoices } from "../ui/named-choices";
import { navigateBack } from "../ui/navigation";
import { spacing } from "../ui/theme";
import { showUndo } from "../ui/undo";

type Patch = { personId: string | null } | { locationId: string | null };

export default function BoxesScreen() {
  const ids = (useLocalSearchParams<{ ids?: string }>().ids ?? "").split(",").filter(Boolean);
  const router = useRouter();
  const cabinet = useCabinet();
  const people = usePeople();
  const locations = useLocations();
  const boxes = cabinet.data.flatMap((product) => product.boxes).filter((box) => ids.includes(box.id));
  // A name added here goes where the chosen boxes are; boxes of two cabinets share no person or place.
  const cabinets = new Set(boxes.map((box) => box.cabinetId));
  const cabinetId = cabinets.size === 1 ? [...cabinets][0]! : null;
  // A tile is lit only when every chosen box already has it.
  const shared = (key: "personId" | "locationId") => {
    const values = new Set(boxes.map((box) => box[key]));
    return values.size === 1 ? [...values][0] : undefined;
  };

  const change = async (patch: Patch) => {
    try {
      const written = await editBoxes(ids, patch);
      navigateBack(router, "/cabinet");
      if (written) showUndo(tr.selection.moved(written.writes.length), () => undoRows(written));
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };

  const addAndChoose = async (table: "people" | "locations", name: string) => {
    if (!cabinetId) return;
    const id = await addNamed(table, cabinetId, name);
    await change(table === "people" ? { personId: id } : { locationId: id });
  };

  return (
    <Screen back="/cabinet" title={tr.selection.title(ids.length)}>
      <Body muted style={{ marginBottom: spacing.md }}>{tr.selection.hint}</Body>
      <NamedChoices table="people" title={tr.selection.whose} named={people.data} chosen={shared("personId")} onChoose={(personId) => void change({ personId })} onAdd={(name) => addAndChoose("people", name)} />
      <NamedChoices
        table="locations"
        title={tr.selection.where}
        named={locations.data}
        chosen={shared("locationId")}
        onChoose={(locationId) => void change({ locationId })}
        onAdd={(name) => addAndChoose("locations", name)}
      />
    </Screen>
  );
}
