/**
 * Gital's selection (`docs/TASKS.md` F1.16): a long press chooses the first
 * row; from then on a tap toggles. The choice is only ever the set of rows
 * still on screen, so deleting the last chosen one, or another device
 * removing it, ends the selection without a handler.
 */
import { useCallback, useState } from "react";
import { BackHandler } from "react-native";
import { useFocusEffect } from "expo-router";

import { mediumTap, selectionTap } from "./haptics";

export interface Selection<Row> {
  /** Whether anything is chosen; rows swap their chevron for the circle. */
  active: boolean;
  count: number;
  allChosen: boolean;
  has: (id: string) => boolean;
  /** The chosen rows that are still on screen, in the order `rows` gave them. */
  chosen: Row[];
  /** Long press: chooses the row, with a medium touch. */
  begin: (id: string) => void;
  /** A tap while a selection is under way. */
  toggle: (id: string) => void;
  selectAll: () => void;
  clear: () => void;
}

export function useSelection<Row extends { id: string }>(rows: readonly Row[]): Selection<Row> {
  const [raw, setRaw] = useState<ReadonlySet<string>>(new Set());
  const chosen = rows.filter((row) => raw.has(row.id));
  // Pruned in state too: a row deleted and then restored by undo must not come back chosen.
  if (chosen.length !== raw.size) setRaw(new Set(chosen.map((row) => row.id)));

  const active = chosen.length > 0;
  const clear = useCallback(() => setRaw(new Set()), []);

  // Losing focus ends it: a selection must not wait behind a pushed screen.
  useFocusEffect(useCallback(() => clear, [clear]));
  useFocusEffect(
    useCallback(() => {
      if (!active) return undefined;
      const back = BackHandler.addEventListener("hardwareBackPress", () => {
        clear();
        return true;
      });
      const escape =
        typeof document === "undefined"
          ? null
          : (event: KeyboardEvent) => {
              // A dialog's Escape is the dialog's: react-native-web closes the Modal on keyup, after this has heard it.
              if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest('[aria-modal="true"]'))) clear();
            };
      if (escape) document.addEventListener("keydown", escape);
      return () => {
        back.remove();
        if (escape) document.removeEventListener("keydown", escape);
      };
    }, [active, clear]),
  );

  return {
    active,
    count: chosen.length,
    allChosen: active && chosen.length === rows.length,
    has: (id) => raw.has(id),
    chosen,
    begin: (id) => {
      mediumTap();
      setRaw((before) => new Set(before).add(id));
    },
    toggle: (id) => {
      selectionTap();
      setRaw((before) => {
        const next = new Set(before);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    },
    selectAll: () => {
      selectionTap();
      setRaw(new Set(rows.map((row) => row.id)));
    },
    clear,
  };
}
