/**
 * The page over the app while an account operation runs, each in its own colour: all four end on the same
 * blank moment, and a bare spinner would make a deletion look like a sign-out. Opacity and scale only, off the busy JS thread.
 */

import { useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import KeyRound from "lucide-react-native/icons/key-round";
import LockOpen from "lucide-react-native/icons/lock-open";
import LogOut from "lucide-react-native/icons/log-out";
import Snowflake from "lucide-react-native/icons/snowflake";
import Trash from "lucide-react-native/icons/trash";

import { SIGN_OUT_PENDING_CHANGES, useSession, type AccountOperation } from "../auth/session";
import { setAccountFrozen } from "../data/settings";
import { tr } from "../i18n/tr";
import { Button, EmptyState } from "./components";
import { appConfirm, appError, appPrompt } from "./dialog";
import { useWaitBreath } from "./motion";
import { borderWidth, circle, motion, operationWait, spacing, type, useTheme } from "./theme";

const VISUALS: Record<AccountOperation, readonly [LucideIcon, "primary" | "secondary" | "warning" | "error"]> = {
  "sign-in": [KeyRound, "primary"],
  "sign-out": [LogOut, "secondary"],
  freeze: [Snowflake, "warning"],
  delete: [Trash, "error"],
};

export function OperationWait({ operation }: { operation: AccountOperation }) {
  const { palette } = useTheme();
  const breath = useWaitBreath(motion.operation.breath, 0.7);
  if (!breath) return null;

  const [Icon, tone] = VISUALS[operation];
  const color = palette[tone];
  const { title, body } = tr.operation[operation];
  return (
    <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", padding: spacing.lg, backgroundColor: palette.background }]}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`${title}. ${body}`}
        style={{ width: "100%", maxWidth: operationWait.maxWidth, alignItems: "center", gap: spacing.lg }}
      >
        <View style={{ width: operationWait.halo, height: operationWait.halo, alignItems: "center", justifyContent: "center" }}>
          <Animated.View
            style={{
              position: "absolute",
              width: operationWait.halo,
              height: operationWait.halo,
              borderRadius: circle(operationWait.halo),
              backgroundColor: color + operationWait.haloTint,
              opacity: breath.interpolate({ inputRange: [0, 1], outputRange: [...operationWait.haloOpacity] }),
              transform: [{ scale: breath.interpolate({ inputRange: [0, 1], outputRange: [...operationWait.haloScale] }) }],
            }}
          />
          <View
            style={{
              width: operationWait.medallion,
              height: operationWait.medallion,
              borderRadius: circle(operationWait.medallion),
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: color + operationWait.medallionTint,
              borderWidth: borderWidth.outline,
              borderColor: color + operationWait.medallionEdge,
            }}
          >
            <Icon accessible={false} size={operationWait.icon} color={color} />
          </View>
        </View>
        <View style={{ gap: spacing.sm, alignItems: "center" }}>
          <Text style={[type.heading, { color: operation === "delete" ? palette.errorText : palette.textStrong, textAlign: "center" }]}>{title}</Text>
          <Text accessibilityLiveRegion="polite" style={[type.body, { color: palette.textSecondary, textAlign: "center" }]}>
            {body}
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Sign out, asking first when a change would be left unsent. */
export async function leaveAccount(): Promise<void> {
  const { signOut } = useSession.getState();
  let refused = await signOut();
  if (refused === SIGN_OUT_PENDING_CHANGES) {
    if (!(await appConfirm(tr.account.signOutTitle, SIGN_OUT_PENDING_CHANGES, tr.account.signOutAnyway))) return;
    refused = await signOut({ force: true });
  }
  if (refused) await appError(refused);
}

/** In place of the app on every device a frozen account holds (SPEC 2.4); reopened with the
 *  password, since the web has no fingerprint. */
export function FrozenGate() {
  const [busy, setBusy] = useState(false);
  const act = (work: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await work();
    } catch {
      await appError(tr.auth.errGeneric);
    }
    setBusy(false);
  };
  const reopen = act(async () => {
    const password = await appPrompt(tr.account.confirmPasswordTitle, tr.account.reopenPasswordBody, { confirmLabel: tr.common.done, kind: "password" });
    if (password == null) return;
    const refused = await useSession.getState().verifyPassword(password);
    if (refused) await appError(refused);
    else await setAccountFrozen(false);
  });
  const leave = act(leaveAccount);
  return (
    <View style={{ flex: 1 }}>
      <EmptyState
        icon={Snowflake}
        title={tr.account.frozenTitle}
        hint={tr.account.frozenBody}
        action={
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.sm }}>
            <Button label={tr.account.reopen} icon={LockOpen} disabled={busy} onPress={() => void reopen()} />
            <Button label={tr.account.signOut} icon={LogOut} variant="ghost" disabled={busy} onPress={() => void leave()} />
          </View>
        }
      />
    </View>
  );
}
