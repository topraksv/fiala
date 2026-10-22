/** What the server refused (SPEC 3.3): each row says what, why and since when; one button resends
 *  all, and any row can be dismissed, which never touches the record. */

import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import CloudCheck from "lucide-react-native/icons/cloud-check";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import X from "lucide-react-native/icons/x";

import { useSession } from "../auth/session";
import { tr } from "../i18n/tr";
import { dismissDeadLetter, readDeadLetters, retryDeadLetter, type DeadLetter } from "../sync/dead-letters";
import { syncNow } from "../sync/engine";
import { useSyncStatus } from "../sync/status";
import { Body, Button, Card, EmptyState, IconButton, Screen } from "../ui/components";
import { appConfirm, appError } from "../ui/dialog";
import { spacing } from "../ui/theme";
import { showNotice } from "../ui/undo";

export default function SyncIssuesScreen() {
  const userId = useSession((s) => s.userId);
  // A sync that ends may have set a row aside, or let one go.
  const lastSyncAt = useSyncStatus((s) => s.lastSyncAt);
  const [letters, setLetters] = useState<DeadLetter[] | null>(null);
  const [missing, setMissing] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => readDeadLetters().then(setLetters), []);
  useEffect(() => void reload().catch(() => appError(tr.errors.readFailedTitle)), [reload, lastSyncAt]);

  const act = (work: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await work();
      await reload();
      // Settings says "some records wait" until a sync has counted them again.
      if (userId) void syncNow(userId);
    } catch {
      void appError(tr.errors.saveFailed);
    }
    setBusy(false);
  };

  const retryAll = act(async () => {
    const gone = new Set<number>();
    for (const letter of letters ?? []) {
      if ((await retryDeadLetter(letter.id)) === "missing") gone.add(letter.id);
    }
    setMissing(gone);
    const sent = (letters?.length ?? 0) - gone.size;
    if (sent > 0) showNotice(tr.sync.retried(sent));
  });

  const dismiss = (letter: DeadLetter, title: string) =>
    act(async () => {
      if (await appConfirm(title, tr.sync.dismissBody, tr.sync.dismiss)) await dismissDeadLetter(letter.id);
    })();

  if (letters == null) return <Screen back="/settings" />;
  if (letters.length === 0) {
    return (
      <Screen back="/settings">
        <EmptyState icon={CloudCheck} title={tr.sync.empty} hint={tr.sync.emptyHint} />
      </Screen>
    );
  }
  return (
    <Screen title={tr.sync.issues} back="/settings">
      <View style={{ gap: spacing.md }}>
        <Body muted>{tr.sync.issuesIntro}</Body>
        <View style={{ alignItems: "flex-start" }}>
          <Button label={tr.common.retry} icon={RefreshCw} disabled={busy} onPress={() => void retryAll()} />
        </View>
        {letters.map((letter) => {
          const title = tr.common.joined(tr.sync.tables[letter.tableName] ?? tr.sync.record, letter.subject ?? undefined);
          const reason = tr.common.joined(tr.sync.reasons[letter.reason], tr.sync.setAside(letter.quarantinedAt));
          return (
            <Card key={letter.id}>
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
                <View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}>
                  <Body>{title}</Body>
                  <Body muted>{missing.has(letter.id) ? tr.sync.missing : reason}</Body>
                </View>
                <IconButton icon={X} label={tr.common.joined(tr.sync.dismiss, title)} disabled={busy} onPress={() => void dismiss(letter, title)} />
              </View>
            </Card>
          );
        })}
      </View>
    </Screen>
  );
}
