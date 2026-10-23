/** Resetting the data: parts chosen, their count shown, confirmed twice — once to what goes,
 *  once with the password — since it leaves every device and cannot be undone. */

import { useEffect, useState } from "react";
import { View } from "react-native";
import Eraser from "lucide-react-native/icons/eraser";

import { useSession } from "../auth/session";
import { countDataReset, resetData, RESET_SCOPES, type ResetScope } from "../data/reset";
import { tr } from "../i18n/tr";
import { Body, Button, Card, Divider, Screen, ToggleRow } from "../ui/components";
import { appConfirm, appError, appPrompt } from "../ui/dialog";
import { spacing } from "../ui/theme";
import { showNotice } from "../ui/undo";

export default function DataResetScreen() {
  const verifyPassword = useSession((s) => s.verifyPassword);
  const userId = useSession((s) => s.userId);
  const [chosen, setChosen] = useState<readonly ResetScope[]>([]);
  const [counted, setCounted] = useState<{ of: readonly ResetScope[]; count: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    countDataReset(chosen, userId ?? "").then(
      (count) => current && setCounted({ of: chosen, count }),
      () => current && void appError(tr.errors.readFailedTitle),
    );
    return () => {
      current = false;
    };
  }, [chosen, userId]);
  // A count of an earlier choice is no count: the button waits for this one's.
  const count = counted?.of === chosen ? counted.count : null;

  const choose = (scope: ResetScope, on: boolean) => setChosen((was) => RESET_SCOPES.filter((each) => (each === scope ? on : was.includes(each))));

  const confirmReset = async (count: number) => {
    if (!(await appConfirm(tr.dataReset.confirmTitle, tr.dataReset.confirmBody(count), tr.dataReset.confirm))) return;
    const password = await appPrompt(tr.account.confirmPasswordTitle, tr.dataReset.passwordBody, { confirmLabel: tr.common.done, kind: "password" });
    if (password == null) return;
    const refused = await verifyPassword(password);
    if (refused) return appError(refused);
    showNotice(tr.dataReset.done(await resetData(chosen, userId ?? "")));
    setChosen([]);
  };
  // `.catch`, not `try`: the React Compiler lowers no `finally`, and leaves the whole screen unmemoised.
  const reset = async () => {
    if (!count) return;
    setBusy(true);
    await confirmReset(count).catch(() => appError(tr.errors.saveFailed));
    setBusy(false);
  };

  return (
    <Screen title={tr.dataReset.title} back="/account-security">
      <View style={{ gap: spacing.md }}>
        <Body muted>{tr.dataReset.intro}</Body>
        <Card rows>
          {RESET_SCOPES.map((scope, at) => (
            <View key={scope}>
              {at > 0 ? <Divider /> : null}
              <ToggleRow
                value={chosen.includes(scope)}
                onValueChange={(on) => choose(scope, on)}
                title={tr.dataReset.scope[scope] ?? scope}
                subtitle={tr.dataReset.scopeHint[scope]}
              />
            </View>
          ))}
        </Card>
        <View accessibilityLiveRegion="polite">{count == null ? null : <Body>{tr.dataReset.count(count)}</Body>}</View>
        <View style={{ alignItems: "flex-start" }}>
          <Button label={tr.dataReset.action} icon={Eraser} disabled={busy || !count} onPress={() => void reset()} />
        </View>
      </View>
    </Screen>
  );
}
