/**
 * Durum's cards open Dolabım's list with its filter set (`docs/UI.md` §11).
 * The filter is handed over in memory rather than in the route: a tab keeps
 * its params, so a second tap on the same card would set nothing, and the
 * list's own choices are not a link worth sharing.
 */

import { router } from "expo-router";

import type { BoxView } from "../domain/boxes";

export interface CabinetFilter {
  view: BoxView;
  /** A person's boxes; `null` is everyone's. */
  person: string | null;
}

let pending: CabinetFilter | null = null;

export function openCabinet(filter: Partial<CabinetFilter>): void {
  pending = { view: "home", person: null, ...filter };
  router.navigate("/cabinet");
}

/** The filter a card asked for, once; null when Dolabım was opened by its tab. */
export function takeCabinetFilter(): CabinetFilter | null {
  const filter = pending;
  pending = null;
  return filter;
}
