import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { CollectedThreadSummary } from "../lib/thread-collection";
import { StoreError, type UserThreadStore } from "../lib/user-thread-store";
import {
  createListMyThreadsHandler,
  createRemoveMyThreadHandler,
  createSaveMyThreadHandler,
  type UserThreadsDeps,
} from "./user-threads";

// ── Fixtures ────────────────────────────────────────────────────────────────

const makeSummary = (overrides: Partial<CollectedThreadSummary> = {}): CollectedThreadSummary => ({
  threadId: "a1b2c3d4e5f6a7b8",
  question: "如何理解算法复杂度",
  createdAt: 1_700_000_000_000,
  sourceCount: 3,
  nodeCount: 7,
  yearRange: "2023—2026",
  ...overrides,
});

interface StoreRecorder {
  readonly store: UserThreadStore;
  readonly saved: Array<{ userId: string; summary: CollectedThreadSummary }>;
  readonly removed: Array<{ userId: string; threadId: string }>;
  readonly listedFor: string[];
}

const makeStoreRecorder = (
  options: {
    readonly rows?: readonly CollectedThreadSummary[];
    readonly failList?: boolean;
    readonly failSave?: boolean;
    readonly failRemove?: boolean;
  } = {},
): StoreRecorder => {
  const saved: Array<{ userId: string; summary: CollectedThreadSummary }> = [];
  const removed: Array<{ userId: string; threadId: string }> = [];
  const listedFor: string[] = [];

  const store: UserThreadStore = {
    list: (userId) => {
      listedFor.push(userId);
      return options.failList
        ? Effect.fail(new StoreError({ reason: "boom" }))
        : Effect.succeed(options.rows ?? []);
    },
    save: (userId, summary) => {
      saved.push({ userId, summary });
      return options.failSave ? Effect.fail(new StoreError({ reason: "boom" })) : Effect.void;
    },
    remove: (userId, threadId) => {
      removed.push({ userId, threadId });
      return options.failRemove ? Effect.fail(new StoreError({ reason: "boom" })) : Effect.void;
    },
  };

  return { store, saved, removed, listedFor };
};

const makeDeps = (
  userId: string | null,
  recorder: StoreRecorder,
): UserThreadsDeps & { readonly storeCalls: () => number } => {
  let storeCalls = 0;
  return {
    readViewerId: async () => userId,
    createStore: async () => {
      storeCalls += 1;
      return recorder.store;
    },
    storeCalls: () => storeCalls,
  };
};

// ── Listing ─────────────────────────────────────────────────────────────────

describe("listMyThreads", () => {
  it("reports an anonymous visitor without touching the store", async () => {
    const recorder = makeStoreRecorder();
    const deps = makeDeps(null, recorder);
    const result = await createListMyThreadsHandler(deps)();

    expect(result).toEqual({ authenticated: false });
    expect(deps.storeCalls()).toBe(0);
  });

  it("returns the account workspace for the signed-in user", async () => {
    const summary = makeSummary();
    const recorder = makeStoreRecorder({ rows: [summary] });
    const result = await createListMyThreadsHandler(makeDeps("zhihu-1", recorder))();

    expect(result).toEqual({ authenticated: true, threads: [summary] });
    expect(recorder.listedFor).toEqual(["zhihu-1"]);
  });

  it("marks the workspace unavailable instead of showing a false empty list", async () => {
    const recorder = makeStoreRecorder({ failList: true });
    const result = await createListMyThreadsHandler(makeDeps("zhihu-1", recorder))();

    expect(result).toEqual({ authenticated: true, threads: [], unavailable: true });
  });
});

// ── Saving ──────────────────────────────────────────────────────────────────

describe("saveMyThread", () => {
  it("refuses anonymous writes", async () => {
    const recorder = makeStoreRecorder();
    const deps = makeDeps(null, recorder);
    const result = await createSaveMyThreadHandler(deps)({ summary: makeSummary() });

    expect(result).toEqual({ changed: false, reason: "NOT_AUTHENTICATED" });
    expect(deps.storeCalls()).toBe(0);
    expect(recorder.saved).toEqual([]);
  });

  it("stores the summary under the signed-in user id", async () => {
    const recorder = makeStoreRecorder();
    const summary = makeSummary();
    const result = await createSaveMyThreadHandler(makeDeps("zhihu-1", recorder))({ summary });

    expect(result).toEqual({ changed: true });
    expect(recorder.saved).toEqual([{ userId: "zhihu-1", summary }]);
  });

  it("rejects malformed summaries", async () => {
    const recorder = makeStoreRecorder();
    const handler = createSaveMyThreadHandler(makeDeps("zhihu-1", recorder));

    const inputs: readonly unknown[] = [
      null,
      {},
      { summary: { ...makeSummary(), threadId: "not-a-thread-id" } },
      { summary: { ...makeSummary(), question: "" } },
      { summary: { ...makeSummary(), question: "x".repeat(301) } },
      { summary: { ...makeSummary(), sourceCount: 0 } },
      { summary: { ...makeSummary(), nodeCount: 1001 } },
      { summary: { ...makeSummary(), createdAt: -1 } },
      { summary: { ...makeSummary(), yearRange: "y".repeat(33) } },
    ];

    for (const input of inputs) {
      expect(await handler(input)).toEqual({ changed: false, reason: "INVALID_REQUEST" });
    }
    expect(recorder.saved).toEqual([]);
  });

  it("reports a store failure without claiming the save happened", async () => {
    const recorder = makeStoreRecorder({ failSave: true });
    const result = await createSaveMyThreadHandler(makeDeps("zhihu-1", recorder))({
      summary: makeSummary(),
    });

    expect(result).toEqual({ changed: false, reason: "STORE_FAILED" });
  });
});

// ── Removing ────────────────────────────────────────────────────────────────

describe("removeMyThread", () => {
  it("removes one thread for the signed-in user", async () => {
    const recorder = makeStoreRecorder();
    const result = await createRemoveMyThreadHandler(makeDeps("zhihu-1", recorder))({
      threadId: "a1b2c3d4e5f6a7b8",
    });

    expect(result).toEqual({ changed: true });
    expect(recorder.removed).toEqual([{ userId: "zhihu-1", threadId: "a1b2c3d4e5f6a7b8" }]);
  });

  it("rejects anonymous or malformed removals", async () => {
    const anonymous = makeStoreRecorder();
    expect(
      await createRemoveMyThreadHandler(makeDeps(null, anonymous))({
        threadId: "a1b2c3d4e5f6a7b8",
      }),
    ).toEqual({ changed: false, reason: "NOT_AUTHENTICATED" });

    const recorder = makeStoreRecorder();
    const handler = createRemoveMyThreadHandler(makeDeps("zhihu-1", recorder));
    expect(await handler({ threadId: "short" })).toEqual({
      changed: false,
      reason: "INVALID_REQUEST",
    });
    expect(await handler(null)).toEqual({ changed: false, reason: "INVALID_REQUEST" });
    expect(recorder.removed).toEqual([]);
  });

  it("reports a store failure", async () => {
    const recorder = makeStoreRecorder({ failRemove: true });
    const result = await createRemoveMyThreadHandler(makeDeps("zhihu-1", recorder))({
      threadId: "a1b2c3d4e5f6a7b8",
    });

    expect(result).toEqual({ changed: false, reason: "STORE_FAILED" });
  });
});
