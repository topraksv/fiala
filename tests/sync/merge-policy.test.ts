/**
 * Sync's pure rules: which outbox event is sent, when a pulled row wins, when a
 * table may be skipped, and what a failed refresh means.
 */

import { describe, expect, it } from "vitest";
import {
  classifyOutboxBatch,
  cursorInstant,
  cursorIsAtServerHead,
  formatPullCursor,
  isAddedAgain,
  isUuidShaped,
  parsePullCursor,
  PULL_EPOCH,
  remoteWinsLww,
  shouldApplyServerAck,
} from "../../src/sync/merge-policy";
import { classifyRefreshFailure, completedSyncState } from "../../src/sync/status";

describe("the outbox batch", () => {
  it("sends the newest event per row, and never an older one behind a corrupt newer one", () => {
    const result = classifyOutboxBatch([
      { id: 1, row_id: "a", payload: JSON.stringify({ id: "a", value: 1 }) },
      { id: 2, row_id: "a", payload: JSON.stringify({ id: "a", value: 2 }) },
      { id: 3, row_id: "a", payload: "{" },
      { id: 4, row_id: "c", payload: JSON.stringify({ id: "other" }) },
      { id: 5, row_id: "d", payload: JSON.stringify({ id: "d", value: 1 }) },
      { id: 6, row_id: "d", payload: JSON.stringify({ id: "d", value: 2 }) },
      { id: 7, row_id: "e", payload: "[]" },
    ]);
    expect(result.latestByRow.has("a")).toBe(false);
    expect(result.latestByRow.get("d")?.row.value).toBe(2);
    expect(result.rejected.map((event) => [event.id, event.reason])).toEqual([
      [3, "malformed_payload"],
      [4, "malformed_payload"],
      [7, "malformed_payload"],
    ]);
  });

  it("does not apply an acknowledgement over a local edit queued meanwhile", () => {
    expect(shouldApplyServerAck(8, 9)).toBe(false);
    expect(shouldApplyServerAck(8, 8)).toBe(true);
    expect(shouldApplyServerAck(8, null)).toBe(true);
  });

  it("reports a finished sync with refused records as needing attention", () => {
    expect(completedSyncState(0)).toBe("idle");
    expect(completedSyncState(1)).toBe("attention");
  });
});

describe("last writer wins", () => {
  const stamp = "2026-09-27T10:00:00.000Z";

  it("converges on an equal timestamp, and lets a valid one repair a corrupt local clock", () => {
    expect(remoteWinsLww(stamp, stamp)).toBe(true);
    expect(remoteWinsLww("not-a-date", stamp)).toBe(true);
    expect(remoteWinsLww(null, stamp)).toBe(true);
    expect(remoteWinsLww("2099-01-01T00:00:00.000Z", stamp)).toBe(false);
    expect(remoteWinsLww(stamp, "not-a-date")).toBe(false);
  });

  it("lets a delete generation outrank any clock", () => {
    expect(remoteWinsLww(stamp, "2099-01-01T00:00:00.000Z", 2, 1)).toBe(false);
    expect(remoteWinsLww("2099-01-01T00:00:00.000Z", stamp, 1, 2)).toBe(true);
  });

  it("adds a row made afresh over a delete it never saw again, and lets an edit go with the delete", () => {
    const deleted = { deleted_at: stamp, tombstone_version: 1, created_at: "2026-09-27T09:00:00.000000+00:00" };
    const made = { deleted_at: null, tombstone_version: 0, created_at: "2026-09-27T09:30:00.000Z" };
    expect(isAddedAgain(made, deleted)).toBe(true);
    expect(isAddedAgain({ ...made, created_at: "2026-09-27T09:00:00.000Z" }, deleted), "the same moment, written two ways").toBe(false);
    expect(isAddedAgain(made, { ...deleted, deleted_at: null }), "the server kept it").toBe(false);
    expect(isAddedAgain(made, { ...deleted, tombstone_version: 0 }), "no newer generation").toBe(false);
    expect(isAddedAgain({ ...made, deleted_at: stamp }, deleted), "a delete sent is no add").toBe(false);
  });

  it("takes only UUID-shaped ids into a filter or a path", () => {
    expect(isUuidShaped("019f6bba-2c65-7ea8-a6c9-96d891155e83")).toBe(true);
    expect(isUuidShaped("a1b2c3d4-e5f6-8a7b-8c9d-0e1f2a3b4c5d")).toBe(true);
    expect(isUuidShaped("x),list_id.eq.attacker")).toBe(false);
    expect(isUuidShaped("../019f6bba-2c65-7ea8-a6c9-96d891155e83")).toBe(false);
    expect(isUuidShaped(42)).toBe(false);
  });
});

describe("the pull cursor", () => {
  const HEAD = { ts: "2026-09-02T10:00:00.000Z", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

  it("round-trips, and reads a missing or legacy cursor as having no id", () => {
    expect(parsePullCursor(formatPullCursor(HEAD))).toEqual(HEAD);
    expect(parsePullCursor("2026-09-02T10:00:00.000Z")).toEqual({ ts: "2026-09-02T10:00:00.000Z", id: "" });
    expect(parsePullCursor(null)).toEqual({ ts: PULL_EPOCH, id: "" });
  });

  it("skips a table only when the cursor stands on its newest row, or it has none", () => {
    expect(cursorIsAtServerHead(HEAD, HEAD)).toBe(true);
    expect(cursorIsAtServerHead(HEAD, null)).toBe(true);
    expect(cursorIsAtServerHead(HEAD, { ...HEAD, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).toBe(false);
    expect(cursorIsAtServerHead(HEAD, { ...HEAD, ts: "2026-09-02T10:00:01.000Z" })).toBe(false);
    expect(cursorIsAtServerHead(parsePullCursor(null), HEAD)).toBe(false);
    expect(cursorIsAtServerHead(HEAD, { ...HEAD, ts: "not a date" })).toBe(false);
  });

  it("reads an id written with no instant before it as the id", () => {
    expect(parsePullCursor("|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toEqual({ ts: "", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });

  it("keeps the server's microseconds, and reads an instant without them as whole milliseconds", () => {
    expect(cursorInstant("2026-09-02T10:00:00.123456+00:00")).toBe("2026-09-02T10:00:00.123456Z");
    expect(cursorInstant("2026-09-02T10:00:00Z")).toBe("2026-09-02T10:00:00.000Z");
  });
});

describe("a pulled row's clock", () => {
  it("never lets a stamp that is not a date win, even over a row with none", () => {
    expect(remoteWinsLww(null, "not a date")).toBe(false);
  });

  it("is not UUID-shaped with a short last group", () => {
    expect(isUuidShaped("019f6bba-2c65-7ea8-a6c9-96d8911")).toBe(false);
  });
});

describe("a failed refresh", () => {
  it("is the network when Auth could not be reached, and the end of the session when it answered", () => {
    const retryable = new Error("Failed to fetch");
    retryable.name = "AuthRetryableFetchError";
    expect(classifyRefreshFailure(retryable)).toBe("unavailable");
    expect(classifyRefreshFailure(new Error("Gateway Timeout (504)"))).toBe("unavailable");
    expect(classifyRefreshFailure(new Error("Invalid Refresh Token: Already Used"))).toBe("expired");
    expect(classifyRefreshFailure(null)).toBe("expired");
  });
});
