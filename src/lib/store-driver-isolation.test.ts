/**
 * Regression guard for the driver-selection boundary.
 *
 * The local factories are used by tests, the eval harness and local tooling.
 * They must never reach a hosted database just because the environment happens
 * to configure one — that silently mixed test data with production data once.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeSqliteExcerptStore } from "./excerpt-store";
import { makeSqliteDailyQuotaStore } from "./sqlite-daily-quota-store";
import { makeSqliteThreadArtifactStore } from "./thread-artifact-store";
import { makeSqliteUserThreadStore } from "./user-thread-store";

const previousUrl = process.env.TURSO_DATABASE_URL;
const previousToken = process.env.TURSO_AUTH_TOKEN;
const tempDirs: string[] = [];

const makeDbPath = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "living-answer-local-only-"));
  tempDirs.push(dir);
  return join(dir, name);
};

beforeEach(() => {
  // A configured hosted database must not change what the local factories do.
  process.env.TURSO_DATABASE_URL = "libsql://not-a-real-host.invalid";
  process.env.TURSO_AUTH_TOKEN = "unused-token";
});

afterEach(() => {
  if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL;
  else process.env.TURSO_DATABASE_URL = previousUrl;
  if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
  else process.env.TURSO_AUTH_TOKEN = previousToken;

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local store factories", () => {
  it("writes excerpts to the local file even when a hosted database is configured", async () => {
    const store = await Effect.runPromise(makeSqliteExcerptStore(makeDbPath("excerpts.db")));
    const now = Date.now();

    await Effect.runPromise(
      store.save({
        questionId: "1",
        answerId: "2",
        capturedAt: now,
        sourceContentId: "probe",
        sourceContentType: "Answer",
        sourceEditTime: now,
        excerpt: "Local-only excerpt",
        fingerprint: "v1:1111111111111111",
      }),
    );

    expect((await Effect.runPromise(store.findLatest("1", "2")))?.excerpt).toBe(
      "Local-only excerpt",
    );
  });

  it("keeps the thread artifact store on the local file", async () => {
    await expect(
      Effect.runPromise(makeSqliteThreadArtifactStore(makeDbPath("threads.db"))),
    ).resolves.toBeDefined();
  });

  it("keeps the quota store on the local file", async () => {
    const store = await Effect.runPromise(
      makeSqliteDailyQuotaStore(makeDbPath("provider-quota.db")),
    );

    expect(await Effect.runPromise(store.reserve("zhihu_search", "2026-09-14", 2))).toBe("allowed");
    expect(await Effect.runPromise(store.reserve("zhihu_search", "2026-09-14", 2))).toBe("allowed");
    expect(await Effect.runPromise(store.reserve("zhihu_search", "2026-09-14", 2))).toBe(
      "exhausted",
    );
  });

  it("keeps the account workspace on the local file", async () => {
    const store = await Effect.runPromise(
      makeSqliteUserThreadStore(makeDbPath("thread-artifacts.db")),
    );

    await Effect.runPromise(
      store.save("local-user", {
        threadId: "aaaaaaaaaaaaaaaa",
        question: "Local-only workspace entry",
        createdAt: Date.now(),
        sourceCount: 1,
        nodeCount: 1,
        yearRange: "2026",
      }),
    );

    expect(await Effect.runPromise(store.list("local-user"))).toHaveLength(1);
  });
});
