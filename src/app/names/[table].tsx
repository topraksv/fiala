/**
 * The cabinet's people, its places (`docs/TASKS.md` F1.18) or its tags
 * (F1.17): added, renamed and deleted here, opened from Dolabım's filter bar.
 * A person opens their own page (F1.20), since they have more than a name.
 * A box that named a deleted one reads as unassigned, a product as untagged.
 * Each cabinet shown keeps its own names (F2.4): the household open, then the
 * person's own.
 */

import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import MapPinPlus from "lucide-react-native/icons/map-pin-plus";
import TagPlus from "lucide-react-native/icons/tag-plus";
import Trash from "lucide-react-native/icons/trash";
import UserPlus from "lucide-react-native/icons/user-plus";

import { addNamed, renameNamed, type NamedTable } from "../../data/cabinet";
import { useHouseholds, useLocations, usePeople, useTags } from "../../data/hooks";
import { deleteRows, undoRows } from "../../db/mutations";
import { tr } from "../../i18n/tr";
import { Body, Button, Card, IconButton, ListRow, Screen, SectionHeader } from "../../ui/components";
import { appConfirm, appError, appPrompt } from "../../ui/dialog";
import { PersonMark } from "../../ui/named-choices";
import { spacing } from "../../ui/theme";
import { showUndo } from "../../ui/undo";

const TABLES: readonly NamedTable[] = ["people", "locations", "tags"];
const ICONS = { people: UserPlus, locations: MapPinPlus, tags: TagPlus };
const EXAMPLES = { people: tr.placeholders.person, locations: tr.placeholders.location, tags: tr.placeholders.tag };

export default function NamesScreen() {
  const asked = useLocalSearchParams<{ table: string }>().table;
  const table = TABLES.find((each) => each === asked) ?? "locations";
  const router = useRouter();
  const { me, open, writes } = useHouseholds();
  const people = usePeople().data;
  const named = { people, locations: useLocations().data, tags: useTags().data }[table];
  const cabinets = [...(open ? [{ id: open.id, name: open.name }] : []), ...(me ? [{ id: me, name: tr.households.private }] : [])];

  const write = async (action: () => Promise<void>, failed: string) => {
    try {
      await action();
    } catch {
      await appError(failed);
    }
  };

  const add = async (cabinetId: string) => {
    const name = (await appPrompt(tr.names.add[table], tr.names.hint[table], { confirmLabel: tr.addBox.add, examples: EXAMPLES[table], maxLength: 80 }))?.trim();
    if (name) await write(async () => void (await addNamed(table, cabinetId, name)), tr.errors.saveFailed);
  };

  const rename = async (id: string, current: string) => {
    const name = (await appPrompt(tr.names.rename, "", { confirmLabel: tr.common.save, initialValue: current, maxLength: 80 }))?.trim();
    if (name && name !== current) await write(() => renameNamed(table, id, name), tr.errors.saveFailed);
  };

  const remove = async (id: string, name: string) => {
    if (!(await appConfirm(tr.names.remove(name), tr.names.removeBody[table], tr.names.removeConfirm))) return;
    await write(async () => {
      const written = await deleteRows(table, [id]);
      if (written) showUndo(tr.common.deleted(name), () => undoRows(written));
    }, tr.errors.deleteFailed);
  };

  return (
    <Screen back="/cabinet" title={tr.names.title[table]}>
      <Body muted style={{ marginBottom: spacing.md }}>{tr.names.hint[table]}</Body>
      {cabinets.map((cabinet) => {
        const own = named.filter((each) => each.cabinetId === cabinet.id);
        const editable = writes(cabinet.id);
        return (
          <View key={cabinet.id}>
            {open ? <SectionHeader>{cabinet.name}</SectionHeader> : null}
            {own.length === 0 ? (
              <Body muted style={{ marginBottom: spacing.md }}>{tr.names.empty[table]}</Body>
            ) : (
              <Card rows>
                {table === "people"
                  ? people
                      .filter((each) => each.cabinetId === cabinet.id)
                      .map((person) => (
                        <ListRow
                          key={person.id}
                          leading={<PersonMark person={person} />}
                          title={person.name}
                          subtitle={person.kind === "pet" ? tr.person.kinds.pet : undefined}
                          chevron
                          onPress={() => router.push({ pathname: "/person/[id]", params: { id: person.id } })}
                        />
                      ))
                  : own.map(({ id, name }) => (
                      <ListRow
                        key={id}
                        title={name}
                        onPress={editable ? () => void rename(id, name) : undefined}
                        right={editable ? <IconButton icon={Trash} label={tr.common.joined(tr.names.removeConfirm, name)} tone="danger" onPress={() => void remove(id, name)} /> : undefined}
                      />
                    ))}
              </Card>
            )}
            {editable ? (
              <View style={{ alignItems: "flex-start" }}>
                <Button label={tr.names.add[table]} icon={ICONS[table]} variant="secondary" onPress={() => void add(cabinet.id)} />
              </View>
            ) : null}
          </View>
        );
      })}
    </Screen>
  );
}
