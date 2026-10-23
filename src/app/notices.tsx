/**
 * The notification centre (`docs/TASKS.md` F1.25): what the cabinet has said
 * over the last thirty days, newest first, the new apart from the read; a row
 * opens what it is about: a box, the cabinet or a household (F2.11). Above
 * them, what asks for the person now.
 */

import type { LucideIcon } from "lucide-react-native";
import { useRouter } from "expo-router";
import Archive from "lucide-react-native/icons/archive";
import Bell from "lucide-react-native/icons/bell";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import CalendarPlus from "lucide-react-native/icons/calendar-plus";
import CalendarX from "lucide-react-native/icons/calendar-x";
import ClipboardCheck from "lucide-react-native/icons/clipboard-check";
import Clock from "lucide-react-native/icons/clock";
import PackageMinus from "lucide-react-native/icons/package-minus";
import PackageOpen from "lucide-react-native/icons/package-open";
import PackagePlus from "lucide-react-native/icons/package-plus";
import PackageX from "lucide-react-native/icons/package-x";
import UserCheck from "lucide-react-native/icons/user-check";
import Pill from "lucide-react-native/icons/pill";
import UserPlus from "lucide-react-native/icons/user-plus";

import { formatDay, localDay } from "../domain/boxes";
import { routeOf, type Reminder, type ReminderKind } from "../domain/reminders";
import { tr } from "../i18n/tr";
import { Body, Card, EmptyState, ListRow, ReadFailed, Screen, SectionHeader } from "../ui/components";
import { Attention } from "../ui/attention";
import { useNotices } from "../ui/notices";
import { spacing, useTheme } from "../ui/theme";

const ICONS: Record<ReminderKind, LucideIcon> = {
  dose: Pill,
  expirySoon: Clock,
  expired: CalendarX,
  openSoon: CalendarClock,
  openEnded: PackageOpen,
  low: PackageMinus,
  empty: PackageX,
  undated: CalendarPlus,
  check: ClipboardCheck,
  asked: UserCheck,
  memberJoined: UserPlus,
  boxAdded: PackagePlus,
  boxLeft: Archive,
};

const WARNED: ReadonlySet<ReminderKind> = new Set(["expired", "openEnded", "empty"]);

export default function Notices() {
  const router = useRouter();
  const { palette } = useTheme();
  const { status, retry, notices, isNew } = useNotices(true);
  const fresh = notices.filter((notice) => isNew(notice.at));
  const read = notices.filter((notice) => !isNew(notice.at));

  const section = (title: string, rows: Reminder[]) =>
    rows.length === 0 ? null : (
      <>
        <SectionHeader>{title}</SectionHeader>
        <Card rows>
          {rows.map((notice) => (
            <ListRow
              key={`${notice.kind} ${notice.at.getTime()} ${notice.name}`}
              icon={ICONS[notice.kind]}
              iconColor={WARNED.has(notice.kind) ? palette.error : undefined}
              title={tr.reminders.kinds[notice.kind]}
              subtitle={tr.common.joined(tr.reminders.body(notice.kind, notice.name, notice.by, notice.count), formatDay(localDay(notice.at)))}
              chevron
              onPress={() => router.push(routeOf(notice.target))}
            />
          ))}
        </Card>
      </>
    );

  if (status === "error") {
    return (
      <Screen back="/" title={tr.notices.title}>
        <ReadFailed queries={[{ retry }]} />
      </Screen>
    );
  }
  return (
    <Screen back="/" title={tr.notices.title}>
      <Attention />
      {status === "loading" ? null : notices.length === 0 ? (
        <EmptyState icon={Bell} title={tr.notices.emptyTitle} hint={tr.notices.emptyHint} />
      ) : (
        <>
          <Body muted style={{ marginBottom: spacing.md }}>{tr.notices.hint}</Body>
          {section(tr.notices.newSection, fresh)}
          {section(tr.notices.readSection, read)}
        </>
      )}
    </Screen>
  );
}
