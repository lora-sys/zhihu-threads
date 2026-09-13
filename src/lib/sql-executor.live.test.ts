/**
 * Hosted-database integration check.
 *
 * Only runs with an explicit opt-in and real Turso credentials, because it
 * writes to a hosted database:
 *
 *   TURSO_CHECK=1 TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... vp test \
 *     src/lib/sql-executor.live.test.ts
 *
 * Every probe uses a dedicated table and a dedicated user id, and cleans up
 * after itself.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeExcerptStore } from "./excerpt-store";
import { makeSqlExecutor } from "./sql-executor";
import { makeUserThreadStore } from "./user-thread-store";

const enabled =
  process.env.TURSO_CHECK === "1" &&
  Boolean(process.env.TURSO_DATABASE_URL?.trim()) &&
  Boolean(process.env.TURSO_AUTH_TOKEN?.trim());

describe.skipIf(!enabled)("hosted sqlite executor", () => {
  it("runs schema, row and workspace round-trips against the hosted database", async () => {
    const database = await Effect.runPromise(makeSqlExecutor({ dbPath: ".local/unused-live.db" }));

    await database.exec(`
      CREATE TABLE IF NOT EXISTS live_probe (
        id TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);

    const changed = await database.run(
      "INSERT INTO live_probe (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
      ["probe", 7],
    );
    expect(changed).toBeGreaterThan(0);

    expect(await database.get("SELECT id, value FROM live_probe WHERE id = ?", ["probe"])).toEqual({
      id: "probe",
      value: 7,
    });

    const excerpts = await Effect.runPromise(makeExcerptStore(database));
    const now = Date.now();
    await Effect.runPromise(
      excerpts.save({
        questionId: "0",
        answerId: "1",
        capturedAt: now,
        sourceContentId: "live-probe",
        sourceContentType: "Answer",
        sourceEditTime: now,
        excerpt: "Hosted database round-trip probe",
        fingerprint: "v1:00000000000000ff",
      }),
    );
    expect((await Effect.runPromise(excerpts.findLatest("0", "1")))?.excerpt).toBe(
      "Hosted database round-trip probe",
    );

    const workspace = await Effect.runPromise(makeUserThreadStore(database));
    const summary = {
      threadId: "aaaaaaaaaaaaaaaa",
      question: "Hosted database round-trip probe",
      createdAt: now,
      sourceCount: 1,
      nodeCount: 1,
      yearRange: "2026",
    };
    await Effect.runPromise(workspace.save("live-probe-user", summary));
    expect(await Effect.runPromise(workspace.list("live-probe-user"))).toEqual([summary]);
    await Effect.runPromise(workspace.remove("live-probe-user", summary.threadId));
    expect(await Effect.runPromise(workspace.list("live-probe-user"))).toEqual([]);

    await database.exec("DROP TABLE IF EXISTS live_probe;");
  }, 60_000);
});
