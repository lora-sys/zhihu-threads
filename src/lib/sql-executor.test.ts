import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  makeLibsqlExecutor,
  makeSqlExecutor,
  type LibsqlClientLike,
  type SqlValue,
} from "./sql-executor";

// ── Fixtures ────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

const makeDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "living-answer-sql-"));
  tempDirs.push(dir);
  return join(dir, "store.db");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface RecordedCall {
  readonly sql: string;
  readonly args: readonly SqlValue[];
}

const makeFakeLibsqlClient = (result: {
  readonly columns?: readonly string[];
  readonly rows: ReadonlyArray<ArrayLike<unknown>>;
  readonly rowsAffected?: number;
}): {
  readonly client: LibsqlClientLike;
  readonly calls: RecordedCall[];
  readonly multiple: string[];
} => {
  const calls: RecordedCall[] = [];
  const multiple: string[] = [];

  const client: LibsqlClientLike = {
    execute: async (statement) => {
      calls.push({ sql: statement.sql, args: statement.args });
      return result;
    },
    executeMultiple: async (sql) => {
      multiple.push(sql);
    },
  };

  return { client, calls, multiple };
};

// ── libSQL adapter ──────────────────────────────────────────────────────────

describe("libSQL executor adapter", () => {
  it("runs DDL through executeMultiple", async () => {
    const { client, multiple } = makeFakeLibsqlClient({ rows: [] });
    await makeLibsqlExecutor(client).exec("CREATE TABLE t (id TEXT);");
    expect(multiple).toEqual(["CREATE TABLE t (id TEXT);"]);
  });

  it("forwards sql and parameters and reports changed rows", async () => {
    const { client, calls } = makeFakeLibsqlClient({ rows: [], rowsAffected: 1 });
    const changed = await makeLibsqlExecutor(client).run("UPDATE t SET v = ? WHERE id = ?", [
      "value",
      7,
    ]);

    expect(changed).toBe(1);
    expect(calls).toEqual([{ sql: "UPDATE t SET v = ? WHERE id = ?", args: ["value", 7] }]);
  });

  it("treats a result without rowsAffected as zero changes", async () => {
    const { client } = makeFakeLibsqlClient({ rows: [] });
    expect(await makeLibsqlExecutor(client).run("INSERT OR IGNORE INTO t VALUES (?)", ["a"])).toBe(
      0,
    );
  });

  it("maps a column-ordered row into named fields", async () => {
    const { client } = makeFakeLibsqlClient({
      columns: ["thread_id", "created_at"],
      rows: [["abc", 42]],
    });

    const row = await makeLibsqlExecutor(client).get<{ thread_id: string; created_at: number }>(
      "SELECT thread_id, created_at FROM t WHERE thread_id = ?",
      ["abc"],
    );

    expect(row).toEqual({ thread_id: "abc", created_at: 42 });
  });

  it("returns undefined when the query has no rows", async () => {
    const { client } = makeFakeLibsqlClient({ columns: ["thread_id"], rows: [] });
    expect(await makeLibsqlExecutor(client).get("SELECT thread_id FROM t")).toBeUndefined();
  });

  it("maps every row for list queries", async () => {
    const { client } = makeFakeLibsqlClient({
      columns: ["thread_id", "saved_at"],
      rows: [
        ["a", 2],
        ["b", 1],
      ],
    });

    const rows = await makeLibsqlExecutor(client).all<{ thread_id: string; saved_at: number }>(
      "SELECT thread_id, saved_at FROM t ORDER BY saved_at DESC",
    );

    expect(rows).toEqual([
      { thread_id: "a", saved_at: 2 },
      { thread_id: "b", saved_at: 1 },
    ]);
  });
});

// ── Driver selection ────────────────────────────────────────────────────────

describe("makeSqlExecutor", () => {
  it("uses a local sqlite file when no hosted database is configured", async () => {
    const dbPath = makeDbPath();
    const database = await Effect.runPromise(makeSqlExecutor({ dbPath, env: {} }));

    await database.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER NOT NULL);");
    expect(await database.run("INSERT INTO t (id, v) VALUES (?, ?)", ["a", 1])).toBe(1);

    expect(await database.get("SELECT id, v FROM t WHERE id = ?", ["a"])).toEqual({
      id: "a",
      v: 1,
    });
  });

  it("enforces conditional updates on the local driver", async () => {
    const database = await Effect.runPromise(makeSqlExecutor({ dbPath: makeDbPath(), env: {} }));

    await database.exec("CREATE TABLE t (id TEXT PRIMARY KEY, used INTEGER NOT NULL);");
    await database.run("INSERT INTO t (id, used) VALUES (?, ?)", ["a", 1]);

    expect(await database.run("UPDATE t SET used = used + 1 WHERE used < ?", [1])).toBe(0);
    expect(await database.run("UPDATE t SET used = used + 1 WHERE used < ?", [2])).toBe(1);
    expect(await database.get("SELECT used FROM t WHERE id = ?", ["a"])).toEqual({ used: 2 });
  });

  it("prefers the hosted database when TURSO_DATABASE_URL is set", async () => {
    const seen: Array<{ url: string; token: string | undefined }> = [];
    const { client } = makeFakeLibsqlClient({ rows: [], rowsAffected: 1 });

    const database = await Effect.runPromise(
      makeSqlExecutor({
        dbPath: makeDbPath(),
        env: { TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "token" },
        loadHostedClient: async (url, token) => {
          seen.push({ url, token });
          return client;
        },
      }),
    );

    expect(seen).toEqual([{ url: "libsql://example.turso.io", token: "token" }]);
    expect(await database.run("INSERT INTO t (id) VALUES (?)", ["a"])).toBe(1);
  });

  it("omits a blank hosted token", async () => {
    const seen: Array<string | undefined> = [];
    const { client } = makeFakeLibsqlClient({ rows: [] });

    await Effect.runPromise(
      makeSqlExecutor({
        dbPath: makeDbPath(),
        env: { TURSO_DATABASE_URL: "libsql://example.turso.io", TURSO_AUTH_TOKEN: "   " },
        loadHostedClient: async (_url, token) => {
          seen.push(token);
          return client;
        },
      }),
    );

    expect(seen).toEqual([undefined]);
  });
});
