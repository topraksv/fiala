import React, { type ReactNode } from "react";
import { View, useWindowDimensions } from "react-native";
import { spacing } from "./theme";

/** Helix's breakpoint for a wide task page: below it every grid is one stream. */
const WIDE_WORKSPACE_WIDTH = 900;

/**
 * Independent peer cards may share a row on a tablet or a desktop, but remain
 * one readable stream on phones; Helix's `WorkspaceGrid`, without the mass
 * balancing no Fiala grid needs yet. The child owns its surface and semantics.
 */
export function WorkspaceGrid({ children }: { children: ReactNode }) {
  const wide = useWindowDimensions().width >= WIDE_WORKSPACE_WIDTH;
  return (
    <View style={{ flexDirection: wide ? "row" : "column", flexWrap: "wrap", alignItems: "stretch", columnGap: wide ? spacing.lg : 0 }}>
      {React.Children.map(children, (child) => (
        <View style={wide ? { flexBasis: "47%", flexGrow: 1, minWidth: 0 } : { width: "100%" }}>{child}</View>
      ))}
    </View>
  );
}
