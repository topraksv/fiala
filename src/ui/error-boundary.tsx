/**
 * A screen that throws while drawing would otherwise
 * unmount the whole tree to a blank page with no way back. This catches it and
 * shows a themed screen whose retry mounts the routes again. It sits inside
 * the theme so the fallback wears the palette. Nothing leaves the device:
 * Fiala collects no crash reports (`docs/PRIVACY.md`), so the error reaches the
 * console only in development.
 */

import { Component, type ReactNode } from "react";
import { View } from "react-native";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";

import { tr } from "../i18n/tr";
import { Button, EmptyState } from "./components";

/** `onShown` is told once the fallback is laid out: the launch screen leaves for it as it would for the routes. */
export class ErrorBoundary extends Component<{ children: ReactNode; onShown?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    if (__DEV__) console.error("error-boundary", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ flex: 1 }} onLayout={this.props.onShown}>
        <EmptyState
          icon={TriangleAlert}
          title={tr.errors.appCrashed}
          hint={tr.errors.appCrashedHint}
          action={<Button label={tr.common.retry} onPress={() => this.setState({ failed: false })} />}
        />
      </View>
    );
  }
}
