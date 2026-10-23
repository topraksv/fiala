/**
 * The notification centre's list and what of it is unread (`docs/TASKS.md`
 * F1.25), for the centre and for Durum's count. Read is a mark on this device,
 * as notifications are: everything said up to the last visit to the centre.
 */

import { useCallback, useMemo, useState } from "react";
import { useFocusEffect } from "expo-router";

import { useCabinet } from "../data/hooks";
import { pastReminders } from "../domain/reminders";
import { tr } from "../i18n/tr";
import { REMINDER_DEFAULTS, readNoticesSeenAt, readReminderPreferences, saveNoticesSeenAt, type ReminderPreferences } from "../services/reminder-preferences";

/**
 * `markRead` is the centre's: it shows as new what was unread when it opened,
 * and leaves everything read for the next look.
 */
export function useNotices(markRead = false) {
  const cabinet = useCabinet();
  // Undefined until read: nothing is counted as new before the mark is known.
  const [seenAt, setSeenAt] = useState<Date | null>();
  // The hour and the silenced kinds, so the centre lists what the phone said (F1.29); none until read.
  const [preferences, setPreferences] = useState<ReminderPreferences | null>(null);
  useFocusEffect(
    useCallback(() => {
      void readReminderPreferences().then(setPreferences, () => setPreferences(REMINDER_DEFAULTS));
      void readNoticesSeenAt()
        .catch(() => null)
        .then((seen) => {
          setSeenAt(seen);
          if (markRead) void saveNoticesSeenAt(new Date()).catch(() => {});
        });
    }, [markRead]),
  );
  const notices = useMemo(
    () =>
      preferences
        ? pastReminders({
            now: new Date(),
            boxes: cabinet.data.flatMap((product) => product.boxes.map((box) => ({ ...box, name: tr.common.boxName(product, box) }))),
            hour: preferences.hour,
            muted: preferences.muted,
          })
        : [],
    [cabinet.data, preferences],
  );
  const isNew = (at: Date) => seenAt !== undefined && (seenAt === null || at > seenAt);
  return { status: cabinet.status, retry: cabinet.retry, notices, isNew, unread: notices.filter((notice) => isNew(notice.at)).length };
}
