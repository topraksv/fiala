/**
 * Invitations into a household (`docs/TASKS.md` F2.2): migration 6's server
 * functions, a link or an offer in the app. Online only, since only the
 * server adds a member. The token rides a link's fragment, which no server
 * along the way logs, and works once. Gital's `src/sync/sharing.ts`, with a
 * household for a list and nothing brought along on joining.
 */

import { create } from "zustand";
import { tr } from "../i18n/tr";
import { kv } from "../services/kv";
import { isNetworkFailure } from "./status";
import { getSupabase } from "./supabase";

export type InviteRole = "editor" | "viewer";

const INVITE_PAGE = "https://topraksv.github.io/fiala/invite";
const TOKEN = /^[0-9a-f]{64}$/;

export const inviteLink = (token: string) => `${INVITE_PAGE}#${token}`;

/**
 * The token a web invitation opened with, read once at launch: signing in
 * first sends the page elsewhere and the fragment with it.
 */
export function inviteFromPage(page: { pathname: string; hash: string } | undefined): string | null {
  return page && /\/invite\/?$/.test(page.pathname) ? inviteTokenFrom(page.hash.slice(1)) : null;
}

const HELD_INVITE_KEY = "fiala.invite";
const HELD_FOR_MS = 7 * 24 * 60 * 60 * 1000;
let held: string | null = null;

/**
 * A web invitation opened signed out, kept until a sign-in takes it. In
 * memory, and in the browser too, since an e-mail confirmation opens another
 * tab and a reload starts afresh. For the link's own seven days at most: the
 * github.io origin is shared with the family's other apps, and the next
 * account to sign in on that browser must not be sent into someone else's
 * household.
 */
export async function holdInvite(token: string): Promise<void> {
  held = token;
  await kv.set(HELD_INVITE_KEY, JSON.stringify({ token, at: Date.now() }));
}

/** The invitation held, if any; `take` lets it go, as the first signed-in read does. */
export async function heldInvite({ take = false } = {}): Promise<string | null> {
  let token = held;
  if (!token) {
    try {
      // A time that is no number compares false; anything else unreadable throws, nothing held either way.
      const stored = JSON.parse((await kv.get(HELD_INVITE_KEY)) ?? "null") as { token: string; at: number };
      if (Date.now() - stored.at < HELD_FOR_MS) token = inviteTokenFrom(stored.token);
    } catch {
      // Unreadable is as good as none.
    }
  }
  if (take) {
    held = null;
    await kv.remove(HELD_INVITE_KEY);
  }
  return token;
}

/** The token in a pasted or scanned link, or in the bare token itself. */
export function inviteTokenFrom(text: string): string | null {
  const trimmed = text.trim();
  const token = trimmed.startsWith(`${INVITE_PAGE}#`) ? trimmed.slice(INVITE_PAGE.length + 1) : trimmed;
  return TOKEN.test(token) ? token : null;
}

type Refused = { refused: string };

/** The server's refusals, by SQLSTATE; the FA codes are migration 6's own. */
const REFUSALS: Record<string, string> = {
  "42501": tr.sharing.errNotOwner,
  "22023": tr.sharing.errInvite,
  FA001: tr.sharing.errPersonal,
  FA002: tr.sharing.errAlreadyIn,
  FA003: tr.sharing.errNotShared,
};

async function call<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ data: T } | Refused> {
  const supabase = getSupabase();
  if (!supabase) return { refused: tr.auth.errNotConfigured };
  const request = supabase.rpc(name, args);
  // supabase-js answers a failed fetch with an error rather than throwing.
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (!error) return { data: data as T };
  return { refused: REFUSALS[error.code] ?? (isNetworkFailure(error.message) ? tr.sync.errNetwork : tr.sharing.errGeneric) };
}

/**
 * Ask, and only when the server does not hold the household yet send it and
 * ask again. Syncing before every invitation made the button wait on a whole
 * sync, photos included (Gital measured it).
 */
async function sendingFirst<T extends object>(ask: () => Promise<T | Refused>, send: () => Promise<unknown>): Promise<T | Refused> {
  const first = await ask();
  if (!("refused" in first) || first.refused !== tr.sharing.errNotOwner) return first;
  await send();
  return ask();
}

/** The owner's link for one person, who joins as `role`; the household is sent first when the server lacks it. */
export function createInvite(cabinetId: string, role: InviteRole, ownerName: string, send: () => Promise<unknown>): Promise<{ token: string } | Refused> {
  return sendingFirst(async () => {
    const answer = await call<string>("create_cabinet_invite", { cabinet: cabinetId, invite_role: role, owner_name: ownerName });
    return "data" in answer ? { token: answer.data } : answer;
  }, send);
}

/** The owner takes back every link to the household not yet used; how many went. */
export async function cancelInvites(cabinetId: string): Promise<{ cancelled: number } | Refused> {
  const answer = await call<number>("cancel_cabinet_invites", { cabinet: cabinetId });
  return "data" in answer ? { cancelled: answer.data } : answer;
}

/** What an invitation is to, from whom and as what, asked before it is spent. */
export interface InvitePeek {
  name: string;
  inviter: string;
  role: InviteRole;
}

/** `null` for a link that leads nowhere: used, expired, taken back, or its household gone. */
export async function peekInvite(token: string): Promise<InvitePeek | null | Refused> {
  const answer = await call<InvitePeek[]>("peek_cabinet_invite", { token });
  return "data" in answer ? (answer.data[0] ?? null) : answer;
}

/** Join by a link; the household arrives with the next sync. */
export async function acceptInvite(token: string, name: string): Promise<{ cabinetId: string } | Refused> {
  const answer = await call<string>("accept_cabinet_invite", { token, member_name: name });
  return "data" in answer ? { cabinetId: answer.data } : answer;
}

/** An offer made to this account, or by it: `to` is this account's id for one received. */
export interface CabinetOffer {
  cabinetId: string;
  cabinetName: string;
  role: InviteRole;
  fromName: string;
  to: string;
}

/**
 * The owner offers a household to someone they already share a live one
 * with, the household sent first when the server lacks it; `role` null
 * withdraws the offer. Offering again changes its role.
 */
export function offerCabinet(cabinetId: string, person: string, role: InviteRole | null, ownerName: string, send: () => Promise<unknown>): Promise<{ offered: true } | Refused> {
  return sendingFirst(async () => {
    const answer = await call<null>("offer_cabinet", { cabinet: cabinetId, person, role, owner_name: ownerName });
    return "data" in answer ? { offered: true as const } : answer;
  }, send);
}

/**
 * The offers waiting on this account and those it made, on households still
 * live. A sync passes its session's signal, so signing out does not wait on it.
 */
export async function listOffers(signal?: AbortSignal): Promise<{ offers: CabinetOffer[] } | Refused> {
  type Row = { cabinet_id: string; cabinet_name: string; role: InviteRole; from_name: string; to_user: string };
  const answer = await call<Row[]>("cabinet_offers", {}, signal);
  if (!("data" in answer)) return answer;
  return {
    offers: answer.data.map((row) => ({ cabinetId: row.cabinet_id, cabinetName: row.cabinet_name, role: row.role, fromName: row.from_name, to: row.to_user })),
  };
}

/**
 * The offers waiting on this account, as the last sync found them. `seen` is
 * the probe's hash they were fetched at (`undefined` before the first), so a
 * sync asks for them only when it moves.
 */
export const useOffers = create<{ seen: string | null | undefined; received: CabinetOffer[] }>(() => ({ seen: undefined, received: [] }));

export function forgetOffers(): void {
  useOffers.setState({ seen: undefined, received: [] });
}

/**
 * Accept an offer, and the household arrives with the next sync; decline, and
 * it is gone with no record (`cabinetId` null). A refusal leaves it waiting.
 */
export async function answerOffer(cabinetId: string, accept: boolean, name: string): Promise<{ cabinetId: string | null } | Refused> {
  const answer = await call<string | null>("answer_cabinet_offer", { cabinet: cabinetId, accept, member_name: name });
  if (!("data" in answer)) return answer;
  // Gone from the screen now; the hash it was seen at stays, so the next sync fetches what is left.
  useOffers.setState((state) => ({ received: state.received.filter((offer) => offer.cabinetId !== cabinetId) }));
  return { cabinetId: answer.data };
}
