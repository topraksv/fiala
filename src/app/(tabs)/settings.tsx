import { useEffect, useState } from "react";
import { Platform, Text, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import * as LocalAuthentication from "expo-local-authentication";
import Bell from "lucide-react-native/icons/bell";
import CircleQuestionMark from "lucide-react-native/icons/circle-question-mark";
import CircleUserRound from "lucide-react-native/icons/circle-user-round";
import CloudOff from "lucide-react-native/icons/cloud-off";
import CloudUpload from "lucide-react-native/icons/cloud-upload";
import KeyRound from "lucide-react-native/icons/key-round";
import LogOut from "lucide-react-native/icons/log-out";
import MessageSquare from "lucide-react-native/icons/message-square";
import ShieldCheck from "lucide-react-native/icons/shield-check";
import Check from "lucide-react-native/icons/check";
import EyeOff from "lucide-react-native/icons/eye-off";
import Monitor from "lucide-react-native/icons/monitor";
import Moon from "lucide-react-native/icons/moon";
import ScanFace from "lucide-react-native/icons/scan-face";
import Sun from "lucide-react-native/icons/sun";

import { useSession } from "../../auth/session";
import { usePeople, useSettings } from "../../data/hooks";
import { profileChoice } from "../../data/settings";
import { partOfDay } from "../../domain/dates";
import { tr } from "../../i18n/tr";
import { REMINDER_DEFAULTS, REMINDER_HOURS, readReminderPreferences, saveReminderHour, saveReminderMuted, saveReminderNames, type ReminderPreferences } from "../../services/reminder-preferences";
import { REMINDER_GROUPS, type ReminderGroup } from "../../domain/reminders";
import { disableReminders, enableReminders, remindersAvailable, replanReminders } from "../../services/reminders";
import { kv } from "../../services/kv";
import { syncNow } from "../../sync/engine";
import { useSyncStatus } from "../../sync/status";
import { isSupabaseConfigured } from "../../sync/supabase";
import { LOCK_KEY, lockName } from "../../ui/app-lock";
import { BrandMark } from "../../ui/brand";
import { PersonMark } from "../../ui/named-choices";
import { Body, Button, Card, ChoiceTile, ListRow, Screen, SectionHeader, ToggleRow } from "../../ui/components";
import { appError } from "../../ui/dialog";
import { shouldPairTiles } from "../../ui/responsive";
import { alpha, appearanceTile, authHero, borderWidth, circle, controlSize, density, PALETTES, radius, spacing, type, useTheme, type Palette, type PaletteId, type ThemePreference } from "../../ui/theme";
import { radioGroupKeys } from "../../ui/keys";
import { leaveAccount } from "../../ui/operation-wait";
import { setAppearance } from "../../ui/theme-transition";

const THEMES: readonly [ThemePreference, string][] = [
  ["system", tr.settings.themeSystem],
  ["light", tr.settings.themeLight],
  ["dark", tr.settings.themeDark],
];

const FAMILIES: readonly [PaletteId, string, string][] = [
  ["clay", tr.settings.paletteClay, tr.settings.paletteClayDesc],
  ["ocean", tr.settings.paletteOcean, tr.settings.paletteOceanDesc],
  ["forest", tr.settings.paletteForest, tr.settings.paletteForestDesc],
];

/** Cards of rows, each a mark, a name, a line and its control at the trailing edge (`docs/UI.md`
 *  section 1); what changes the account lives a row away, on Hesap Güvenliği. */
export default function SettingsScreen() {
  const { palette, scheme, paletteId, preference } = useTheme();
  const { width } = useWindowDimensions();
  const stacked = !shouldPairTiles(width);
  const settings = useSettings();
  const people = usePeople();
  const me = people.data.find((person) => person.id === profileChoice(settings.data, "me", people.data));
  return (
    <Screen title={tr.tabs.settings} width="workspace">
      <Greeting me={me} />
      <Card rows>
        <ListRow icon={CircleUserRound} title={tr.profile.title} subtitle={tr.profile.row} chevron onPress={() => router.push("/profile")} />
      </Card>
      <SectionHeader>{tr.settings.appSection}</SectionHeader>
      <Card>
        <Body style={{ marginBottom: spacing.sm }}>{tr.settings.theme}</Body>
        <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.settings.theme} style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg }}>
          {THEMES.map(([value, label]) => (
            <ThemeChoice
              key={value}
              value={value}
              label={label}
              selected={preference === value}
              light={PALETTES[paletteId].light}
              dark={PALETTES[paletteId].dark}
              onPress={() => setAppearance({ theme: value }, palette.background)}
            />
          ))}
        </View>
        <Body style={{ marginBottom: spacing.sm }}>{tr.settings.palette}</Body>
        <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.settings.palette} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {FAMILIES.map(([id, label, description]) => (
            <PaletteChoice
              key={id}
              label={label}
              description={description}
              swatch={PALETTES[id][scheme]}
              selected={paletteId === id}
              stacked={stacked}
              onPress={() => setAppearance({ palette: id }, palette.background)}
            />
          ))}
        </View>
      </Card>
      {remindersAvailable ? <Reminders /> : null}
      {isSupabaseConfigured ? (
        <>
          <SectionHeader>{tr.settings.syncSection}</SectionHeader>
          <Sync />
        </>
      ) : null}
      <Card rows>
        <ListRow icon={ShieldCheck} title={tr.legal.title} subtitle={tr.legal.subtitle} chevron onPress={() => router.push("/privacy")} />
      </Card>
      {isSupabaseConfigured ? (
        <>
          <SectionHeader>{tr.account.section}</SectionHeader>
          <Card rows>
            <ListRow icon={KeyRound} title={tr.account.security} subtitle={tr.account.securityDesc} chevron onPress={() => router.push("/account-security")} />
            {Platform.OS === "web" ? null : <AppLock />}
          </Card>
          <Card rows>
            <ListRow icon={LogOut} title={tr.account.signOut} subtitle={tr.account.signOutDescription} chevron onPress={() => void leaveAccount()} />
          </Card>
        </>
      ) : null}
      {/* Last: the rows here that change nothing, and a person looking for
          them is looking for the bottom of the page. */}
      <SectionHeader>{tr.help.title}</SectionHeader>
      <Card rows>
        <ListRow icon={CircleQuestionMark} title={tr.help.title} subtitle={tr.help.row} chevron onPress={() => router.push("/help")} />
        <ListRow icon={MessageSquare} title={tr.feedback.title} subtitle={tr.feedback.settingsDesc} chevron onPress={() => router.push("/feedback")} />
      </Card>
      <Body muted style={{ fontSize: type.small.fontSize, textAlign: "center", marginTop: spacing.md }}>{tr.settings.footer}</Body>
    </Screen>
  );
}

/**
 * The phone's own reminders (`docs/TASKS.md` F1.24, F1.29): the permission is
 * asked from the first switch alone; the rest shows once it is on.
 */
function Reminders() {
  const [preferences, setPreferences] = useState<ReminderPreferences | null>(null);
  useEffect(() => void readReminderPreferences().then(setPreferences, () => setPreferences(REMINDER_DEFAULTS)), []);
  if (!preferences) return null;
  const { on, hour, muted } = preferences;
  // Drawn at once, and put back to what the phone ended with: refused, or failed.
  const turn = (next: boolean) => {
    setPreferences({ ...preferences, on: next });
    (next ? enableReminders() : disableReminders().then(() => false)).then(
      (allowed) => {
        if (next && !allowed) {
          setPreferences({ ...preferences, on: false });
          void appError(tr.reminders.denied);
        }
      },
      () => {
        void readReminderPreferences().then(setPreferences, () => {});
        void appError(tr.errors.saveFailed);
      },
    );
  };
  const change = (next: Partial<ReminderPreferences>, save: Promise<void>) => {
    setPreferences({ ...preferences, ...next });
    save.then(replanReminders).catch(() => appError(tr.errors.saveFailed));
  };
  const mute = (group: ReminderGroup) => (said: boolean) => {
    const next = said ? muted.filter((each) => each !== group) : [...muted, group];
    change({ muted: next }, saveReminderMuted(next));
  };
  return (
    <>
      <SectionHeader>{tr.reminders.title}</SectionHeader>
      <Card rows>
        <ToggleRow icon={Bell} title={tr.reminders.title} subtitle={tr.reminders.hint} value={on} onValueChange={turn} />
        {on ? (
          <>
            <ToggleRow icon={EyeOff} title={tr.reminders.names} subtitle={tr.reminders.namesHint} value={preferences.names} onValueChange={(names) => change({ names }, saveReminderNames(names))} />
            {(Object.keys(REMINDER_GROUPS) as ReminderGroup[]).map((group) => (
              <ToggleRow key={group} title={tr.reminders.groups[group]} value={!muted.includes(group)} onValueChange={mute(group)} />
            ))}
          </>
        ) : null}
      </Card>
      {on ? (
        <Card>
          <Body style={{ marginBottom: spacing.sm }}>{tr.reminders.hour}</Body>
          <View role="radiogroup" {...radioGroupKeys()} accessibilityLabel={tr.reminders.hour} style={{ flexDirection: "row", gap: spacing.sm }}>
            {REMINDER_HOURS.map((offered) => (
              <ChoiceTile key={offered} label={tr.reminders.at(offered)} selected={hour === offered} minHeight={controlSize.minimumTarget} onPress={() => change({ hour: offered }, saveReminderHour(offered))} />
            ))}
          </View>
        </Card>
      ) : null}
    </>
  );
}

/**
 * The app lock (`docs/TASKS.md` F1.30), named for the sensor the phone has; the
 * neutral name covers the frame before the hardware answers. On this device
 * only, as Helix keeps it.
 */
function AppLock() {
  const [label, setLabel] = useState<string>(tr.lock.name);
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void kv.get(LOCK_KEY).then((value) => alive && setOn(value === "true"), () => alive && setOn(false));
    void LocalAuthentication.supportedAuthenticationTypesAsync().then(
      (types) =>
        alive &&
        setLabel(
          lockName({
            ios: Platform.OS === "ios",
            facial: types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION),
            fingerprint: types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT),
          }),
        ),
      // An unreadable sensor list keeps the neutral name, already right.
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  const turn = (next: boolean) => {
    setOn(next);
    kv.set(LOCK_KEY, String(next)).catch(() => {
      setOn(!next);
      void appError(tr.errors.saveFailed);
    });
  };
  return <ToggleRow icon={ScanFace} title={label} subtitle={tr.lock.hint} value={on === true} disabled={on === null} onValueChange={turn} />;
}

/** Under the page's own title, so the tabs keep one title line. The tab stays mounted, so the
 *  hour is read again on the hour. The account's person, once chosen (F1.28), is greeted by
 *  name, their picture in place of the mark. */
function Greeting({ me }: { me?: Parameters<typeof PersonMark>[0]["person"] }) {
  const { palette } = useTheme();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 0, 0);
    const timer = setTimeout(() => setNow(new Date()), next.getTime() - now.getTime());
    return () => clearTimeout(timer);
  }, [now]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.md }}>
      {me ? <PersonMark person={me} size={authHero.mark} /> : <BrandMark height={authHero.mark} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" aria-level={2} style={[type.heading, { color: palette.textStrong }]}>
          {me ? tr.settings.named(tr.settings.greeting[partOfDay(now)], me.name) : tr.settings.greeting[partOfDay(now)]}
        </Text>
        <Body muted>{tr.settings.welcome}</Body>
      </View>
    </View>
  );
}

/** Sync: its state, when it last finished, a button to run it; what the server refused
 *  opens on its own screen, since nothing is lost and nothing is urgent. */
function Sync() {
  const { palette } = useTheme();
  const userId = useSession((s) => s.userId);
  const { state, lastSyncAt, error } = useSyncStatus();
  // Idle before a first sync has finished is not "synced": a fresh sign-in or
  // an offline device would read green for a copy that never left it.
  const never = state === "idle" && !lastSyncAt;
  const tone = never ? palette.textSecondary : state === "idle" ? palette.success : state === "error" ? palette.error : palette.warning;
  const said = never ? tr.sync.never : tr.sync[state];
  return (
    <Card rows>
      <ListRow
        icon={CloudUpload}
        iconColor={tone}
        title={tr.sync.title}
        subtitle={lastSyncAt ? tr.common.joined(said, tr.sync.lastSync(lastSyncAt)) : said}
        right={
          <Button
            label={tr.sync.now}
            variant="secondary"
            size="sm"
            loading={state === "syncing"}
            disabled={!userId || state === "syncing"}
            onPress={() => userId && void syncNow(userId)}
          />
        }
      />
      {state === "error" ? (
        <Text accessibilityRole="alert" style={[type.small, { color: palette.errorText, marginTop: spacing.xs }]}>{error ?? tr.sync.errGeneric}</Text>
      ) : null}
      <Body muted style={{ fontSize: type.small.fontSize, marginTop: spacing.xs, marginBottom: density.list.cardPadding }}>{tr.settings.syncExplain}</Body>
      {state === "attention" ? (
        <ListRow icon={CloudOff} title={tr.sync.issues} subtitle={tr.sync.errQuarantined} chevron onPress={() => router.push("/sync-issues")} />
      ) : null}
    </Card>
  );
}

/** A window split in its own light and dark grounds, with the mode's mark over it. */
function ThemeChoice({ value, label, selected, light, dark, onPress }: {
  value: ThemePreference;
  label: string;
  selected: boolean;
  light: Palette;
  dark: Palette;
  onPress: () => void;
}) {
  const Icon = value === "light" ? Sun : value === "dark" ? Moon : Monitor;
  const tile = appearanceTile.theme;
  return (
    <ChoiceTile label={label} selected={selected} onPress={onPress} minHeight={tile.minHeight}>
      <View
        accessible={false}
        style={{
          width: tile.swatch.width,
          height: tile.swatch.height,
          overflow: "hidden",
          flexDirection: "row",
          borderRadius: radius.sm,
          borderWidth: borderWidth.outline,
          borderColor: selected ? light.primary : light.border + alpha.edge,
        }}
      >
        <View style={{ flex: 1, backgroundColor: value === "dark" ? dark.background : light.background }} />
        {value === "system" ? <View style={{ flex: 1, backgroundColor: dark.background }} /> : null}
        <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
          <Icon size={tile.icon} color={value === "dark" ? dark.textStrong : light.textStrong} />
        </View>
      </View>
    </ChoiceTile>
  );
}

/** A miniature of the palette's own page: a card on its ground, its accent, its status pair. */
function PaletteChoice({ label, description, swatch, selected, stacked, onPress }: {
  label: string;
  description: string;
  swatch: Palette;
  selected: boolean;
  stacked: boolean;
  onPress: () => void;
}) {
  const tile = appearanceTile.palette;
  const lineColours = [swatch.textStrong, swatch.border, swatch.surfaceStrong];
  return (
    <ChoiceTile
      label={label}
      description={description}
      selected={selected}
      onPress={onPress}
      layout={stacked ? "row" : "stack"}
      basis={stacked ? "100%" : undefined}
      minHeight={stacked ? tile.minHeight : tile.wideMinHeight}
      surface={swatch}
    >
      <View
        accessible={false}
        style={{
          width: stacked ? tile.swatch.width : "100%",
          height: stacked ? tile.swatch.height : tile.swatch.wideHeight,
          flexShrink: 0,
          overflow: "hidden",
          borderRadius: radius.md,
          borderWidth: borderWidth.outline,
          borderColor: swatch.border + alpha.edge,
          backgroundColor: swatch.background,
        }}
      >
        <View
          style={{
            position: "absolute",
            left: spacing.sm,
            top: spacing.sm,
            right: stacked ? tile.cardRight : tile.wideCardRight,
            bottom: spacing.sm,
            padding: spacing.sm,
            gap: tile.lineGap,
            borderRadius: radius.sm,
            backgroundColor: swatch.surface,
          }}
        >
          {tile.lines.map((line, i) => (
            <View key={line.width} style={{ width: line.width, height: line.height, borderRadius: line.radius, backgroundColor: lineColours[i] }} />
          ))}
        </View>
        <View style={{ position: "absolute", right: spacing.sm, top: spacing.sm, width: tile.dot, height: tile.dot, borderRadius: circle(tile.dot), backgroundColor: swatch.primary }} />
        <View style={{ position: "absolute", right: spacing.sm, bottom: spacing.sm, flexDirection: "row", gap: tile.pipGap }}>
          <View style={{ width: tile.pip, height: tile.pip, borderRadius: circle(tile.pip), backgroundColor: swatch.success }} />
          <View style={{ width: tile.pip, height: tile.pip, borderRadius: circle(tile.pip), backgroundColor: swatch.error }} />
        </View>
        {selected ? (
          <View
            style={{
              position: "absolute",
              right: spacing.sm + (tile.dot - tile.check) / 2,
              top: spacing.sm + (tile.dot - tile.check) / 2,
              width: tile.check,
              height: tile.check,
              borderRadius: circle(tile.check),
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: swatch.primary,
            }}
          >
            <Check size={tile.checkIcon} color={swatch.onPrimary} strokeWidth={tile.checkStroke} />
          </View>
        ) : null}
      </View>
    </ChoiceTile>
  );
}
