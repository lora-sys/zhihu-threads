import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { CollectedThreadSummary } from "./thread-collection";
import { makeSqliteUserThreadStore } from "./user-thread-store";

// ── Fixtures ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "living-answer-user-threads-"));
  tempDirs.push(dir);
  return join(dir, "thread-artifacts.db");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const makeSummary = (overrides: Partial<CollectedThreadSummary> = {}): CollectedThreadSummary => ({
  threadId: "a1b2c3d4e5f6a7b8",
  question: "如何理解算法复杂度",
  createdAt: 1_700_000_000_000,
  sourceCount: 3,
  nodeCount: 7,
  yearRange: "2023—2026",
  ...overrides,
});

const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// ── Store behaviour ─────────────────────────────────────────────────────────

describe("user thread store", () => {
  it("saves and lists a summary for one user", async () => {
    const store = await run(makeSqliteUserThreadStore(makeDbPath()));
    const summary = makeSummary();

    await run(store.save("user-1", summary));
    expect(await run(store.list("user-1"))).toEqual([summary]);
  });

  it("keeps each user's workspace separate", async () => {
    const store = await run(makeSqliteUserThreadStore(makeDbPath()));

    await run(store.save("user-1", makeSummary({ threadId: "aaaaaaaaaaaaaaaa" })));
    await run(store.save("user-2", makeSummary({ threadId: "bbbbbbbbbbbbbbbb" })));

    expect((await run(store.list("user-1"))).map((item) => item.threadId)).toEqual([
      "aaaaaaaaaaaaaaaa",
    ]);
    expect((await run(store.list("user-2"))).map((item) => item.threadId)).toEqual([
      "bbbbbbbbbbbbbbbb",
    ]);
  });

  it("updates an existing entry instead of duplicating it", async () => {
    const store = await run(makeSqliteUserThreadStore(makeDbPath()));

    await run(store.save("user-1", makeSummary({ question: "第一次保存" })));
    await run(store.save("user-1", makeSummary({ question: "更新后的标题", nodeCount: 9 })));

    const listed = await run(store.list("user-1"));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.question).toBe("更新后的标题");
    expect(listed[0]?.nodeCount).toBe(9);
  });

  it("removes only the selected thread for that user", async () => {
    const store = await run(makeSqliteUserThreadStore(makeDbPath()));
    const keep = makeSummary({ threadId: "cccccccccccccccc" });
    const drop = makeSummary({ threadId: "dddddddddddddddd" });

    await run(store.save("user-1", keep));
    await run(store.save("user-1", drop));
    await run(store.save("user-2", drop));

    await run(store.remove("user-1", drop.threadId));

    expect(await run(store.list("user-1"))).toEqual([keep]);
    expect((await run(store.list("user-2"))).map((item) => item.threadId)).toEqual([
      "dddddddddddddddd",
    ]);
  });

  it("starts from an empty workspace and tolerates reopening the same file", async () => {
    const dbPath = makeDbPath();

    const first = await run(makeSqliteUserThreadStore(dbPath));
    expect(await run(first.list("user-1"))).toEqual([]);
    await run(first.save("user-1", makeSummary()));

    const reopened = await run(makeSqliteUserThreadStore(dbPath));
    expect(await run(reopened.list("user-1"))).toHaveLength(1);
  });
});
