/**
 * A second web tab cannot open the OPFS database until it reloads, so it asks who holds it and reloads on silence.
 * Not `pagehide` (it fires on same-tab navigation) nor focus (a background tab may never raise it).
 */

import { useEffect, useState } from "react";
import { Platform } from "react-native";

const CHANNEL = "fiala.database.holder";
/** Long enough for a live holder to answer, short enough not to keep a stale screen. */
const REPLY_GRACE_MS = 500;
const PROBE_MS = 2000;
const MAX_RELOADS = 2;
const RELOADS_KEY = "fiala.database.autoreload";

function reloadsSpent(): number {
  try {
    return Number(sessionStorage.getItem(RELOADS_KEY) ?? 0) || 0;
  } catch {
    // A browser refusing session storage gets the button, not a loop.
    return MAX_RELOADS;
  }
}

function spendReload(): void {
  try {
    sessionStorage.setItem(RELOADS_KEY, String(reloadsSpent() + 1));
  } catch {
    // The read above already refuses when this would fail.
  }
}

/** `heldElsewhere`: another tab answered, so the screen stops offering a reload that would land on itself. */
export function useDatabaseHandoff(open: boolean, failed: boolean): { heldElsewhere: boolean } {
  const [heldElsewhere, setHeldElsewhere] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof BroadcastChannel === "undefined") return;
    if (!open && !failed) return;
    const channel = new BroadcastChannel(CHANNEL);
    if (open) {
      // Opened, so the ceiling is for the next wait, not spent by this one.
      try {
        sessionStorage.removeItem(RELOADS_KEY);
      } catch {
        // Nothing was spent where nothing could be stored.
      }
      channel.onmessage = (event) => {
        if (event.data === "who-has-it") channel.postMessage("i-do");
      };
      return () => channel.close();
    }

    let grace: ReturnType<typeof setTimeout> | null = null;
    const stopWaiting = () => {
      if (grace) clearTimeout(grace);
      grace = null;
    };
    channel.onmessage = (event) => {
      if (event.data !== "i-do") return;
      stopWaiting();
      setHeldElsewhere(true);
    };
    const ask = (mayReload: boolean) => {
      if (grace) return;
      channel.postMessage("who-has-it");
      // The ceiling stops the reload, never the question: knowing another tab
      // holds it matters most once reloading has been given up on.
      if (!mayReload || reloadsSpent() >= MAX_RELOADS) return;
      grace = setTimeout(() => {
        grace = null;
        spendReload();
        window.location.reload();
      }, REPLY_GRACE_MS);
    };
    // The first question only wants an answer: a holder slow to reply, a
    // throttled background tab, should not cost a reload before anything shows.
    ask(false);
    const probe = setInterval(() => ask(true), PROBE_MS);
    return () => {
      stopWaiting();
      clearInterval(probe);
      channel.close();
    };
  }, [open, failed]);

  return { heldElsewhere };
}
