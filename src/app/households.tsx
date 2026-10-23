/**
 * Which household Dolabım shows beside the person's own boxes, and a new one
 * opened (`docs/TASKS.md` F2.4). Reached from the row under Dolabım's title;
 * each household's people and invitations are a press away (F2.3), and a
 * link someone sent is joined from here (F2.2).
 */

import { View } from "react-native";
import { useRouter } from "expo-router";
import House from "lucide-react-native/icons/house";
import HousePlus from "lucide-react-native/icons/house-plus";
import LogIn from "lucide-react-native/icons/log-in";
import Users from "lucide-react-native/icons/users";

import { openHousehold } from "../data/cabinet";
import { useHouseholds } from "../data/hooks";
import { chooseHousehold } from "../data/settings";
import { tr } from "../i18n/tr";
import { Body, Button, Card, IconButton, ListRow, Screen } from "../ui/components";
import { appError, appPrompt } from "../ui/dialog";
import { PersonMark } from "../ui/named-choices";
import { spacing } from "../ui/theme";

export default function HouseholdsScreen() {
  const router = useRouter();
  const { me, households, open } = useHouseholds();
  const back = () => (router.canGoBack() ? router.back() : router.replace("/cabinet"));

  const choose = async (id: string) => {
    try {
      await chooseHousehold(id);
      back();
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };

  const add = async () => {
    const name = (await appPrompt(tr.households.open, tr.households.openBody, { confirmLabel: tr.households.openConfirm, examples: tr.households.examples, maxLength: 80 }))?.trim();
    if (!name || !me) return;
    try {
      await choose(await openHousehold(me, name));
    } catch {
      await appError(tr.errors.saveFailed);
    }
  };

  return (
    <Screen back="/cabinet" title={tr.households.title}>
      <Body muted style={{ marginBottom: spacing.md }}>{tr.households.hint}</Body>
      {households.data.length > 0 ? (
        <Card rows>
          {households.data.map((household) => (
            <ListRow
              key={household.id}
              icon={household.thumb ? undefined : House}
              leading={<PersonMark person={{ ...household, color: null }} />}
              title={household.name}
              subtitle={tr.households.people(household.members)}
              selected={household.id === open?.id}
              onPress={() => void choose(household.id)}
              right={<IconButton icon={Users} label={tr.sharing.open(household.name)} onPress={() => router.push({ pathname: "/household/[id]", params: { id: household.id } })} />}
            />
          ))}
        </Card>
      ) : null}
      <View style={{ alignItems: "flex-start", gap: spacing.sm }}>
        <Button label={tr.households.open} icon={HousePlus} variant="secondary" onPress={() => void add()} />
        <Button label={tr.sharing.join} icon={LogIn} variant="ghost" onPress={() => router.push("/invite")} />
      </View>
    </Screen>
  );
}
