/**
 * Minimal SQL execution port shared by every store.
 *
 * The product needs the same SQLite SQL in two places: a local file database
 * (development, tests, a container with a volume) and a hosted libSQL/SQLite
 * database (deployments without persistent disk). Keeping one port lets the
 * store modules own the SQL while only the driver changes.
 *
 * @module sql-executor
 */

import { Data, Effect } from "effect";

// ── Errors ─────────────────────────────────────────────────────────────────────

export class SqlExecutorError extends Data.TaggedError("SqlExecutorError")<{
  readonly reason: string;
}> {}

// ── Port ───────────────────────────────────────────────────────────────────────

export type SqlValue = string | number | null | Uint8Array;

export interface SqlExecutor {
  /** Run multi-statement DDL (schema setup). */
  readonly exec: (sql: string) => Promise<void>;
  /** Run one statement and report how many rows it changed. */
  readonly run: (sql: string, params?: readonly SqlValue[]) => Promise<number>;
  /** Run one statement and return its first row, if any. */
  readonly get: <Row extends Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ) => Promise<Row | undefined>;
  /** Run one statement and return every row. */
  readonly all: <Row extends Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ) => Promise<readonly Row[]>;
}

/** Structured view of a libSQL result set; keeps our adapter independent of the SDK types. */
export interface LibsqlResultLike {
  readonly columns?: readonly string[];
  readonly rows: ReadonlyArray<ArrayLike<unknown>>;
  readonly rowsAffected?: number;
}

export interface LibsqlClientLike {
  readonly execute: (statement: {
    readonly sql: string;
    readonly args: readonly SqlValue[];
  }) => Promise<LibsqlResultLike>;
  readonly executeMultiple: (sql: string) => Promise<unknown>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toRow = (result: LibsqlResultLike, index: number): Record<string, unknown> | undefined => {
  const row = result.rows[index];
  if (!row) return undefined;

  const columns = result.columns ?? [];
  if (columns.length > 0) {
    return Object.fromEntries(columns.map((column, position) => [column, row[position]]));
  }

  return { ...(row as unknown as Record<string, unknown>) };
};

const toRows = (result: LibsqlResultLike): readonly Record<string, unknown>[] =>
  result.rows
    .map((_row, index) => toRow(result, index))
    .filter((row): row is Record<string, unknown> => row !== undefined);

// ── libSQL (Turso) driver ──────────────────────────────────────────────────────

/**
 * Wrap an HTTP libSQL client. `client` is injectable so the adapter contract is
 * covered by tests without reaching a hosted database.
 */
export const makeLibsqlExecutor = (client: LibsqlClientLike): SqlExecutor => ({
  exec: async (sql) => {
    await client.executeMultiple(sql);
  },
  run: async (sql, params = []) => {
    const result = await client.execute({ sql, args: params });
    return Number(result.rowsAffected ?? 0);
  },
  get: async <Row extends Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ) => {
    const result = await client.execute({ sql, args: params });
    return toRow(result, 0) as Row | undefined;
  },
  all: async <Row extends Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ) => {
    const result = await client.execute({ sql, args: params });
    return toRows(result) as unknown as readonly Row[];
  },
});

const loadLibsqlClient = async (
  url: string,
  authToken: string | undefined,
): Promise<LibsqlClientLike> => {
  const { createClient } = await import("@libsql/client/web");
  return createClient({
    url,
    ...(authToken === undefined ? {} : { authToken }),
  }) as unknown as LibsqlClientLike;
};

// ── better-sqlite3 driver ──────────────────────────────────────────────────────

/**
 * Wrap a local SQLite file. Node-only modules are imported lazily so nothing
 * here can reach the client bundle.
 */
export const makeBetterSqliteExecutor = (
  dbPath: string,
): Effect.Effect<SqlExecutor, SqlExecutorError> =>
  Effect.tryPromise({
    try: async () => {
      const nodePath = (await import("node:path")).default;
      const nodeFs = (await import("node:fs")).default;
      const betterSqlite3 = (await import("better-sqlite3")).default;

      const parent = nodePath.dirname(dbPath);
      if (!nodeFs.existsSync(parent)) {
        nodeFs.mkdirSync(parent, { recursive: true });
      }

      const database = betterSqlite3(dbPath, { fileMustExist: false });

      return {
        exec: async (sql: string) => {
          database.exec(sql);
        },
        run: async (sql: string, params: readonly SqlValue[] = []) =>
          Number(database.prepare(sql).run(...params).changes),
        get: async <Row extends Record<string, unknown>>(
          sql: string,
          params: readonly SqlValue[] = [],
        ) => database.prepare(sql).get(...params) as Row | undefined,
        all: async <Row extends Record<string, unknown>>(
          sql: string,
          params: readonly SqlValue[] = [],
        ) => database.prepare(sql).all(...params) as Row[],
      } satisfies SqlExecutor;
    },
    catch: (error) =>
      new SqlExecutorError({ reason: `failed to open sqlite db at ${dbPath}: ${describe(error)}` }),
  });

// ── Selection ──────────────────────────────────────────────────────────────────

export interface MakeSqlExecutorOptions {
  /** Local database file used when no hosted database is configured. */
  readonly dbPath: string;
  /** Override the hosted-database environment (tests). */
  readonly env?: {
    readonly TURSO_DATABASE_URL?: string | undefined;
    readonly TURSO_AUTH_TOKEN?: string | undefined;
  };
  /** Override the hosted client (tests). */
  readonly loadHostedClient?: (
    url: string,
    authToken: string | undefined,
  ) => Promise<LibsqlClientLike>;
}

/**
 * Pick the hosted libSQL database when `TURSO_DATABASE_URL` is configured, and
 * fall back to a local file otherwise. That single switch is what lets the same
 * build run on a laptop, in Docker with a volume, or on a host without disk.
 */
export const makeSqlExecutor = (
  options: MakeSqlExecutorOptions,
): Effect.Effect<SqlExecutor, SqlExecutorError> =>
  Effect.gen(function* () {
    const env = options.env ?? process.env;
    const url = env.TURSO_DATABASE_URL?.trim();

    if (!url) {
      return yield* makeBetterSqliteExecutor(options.dbPath);
    }

    const authToken = env.TURSO_AUTH_TOKEN?.trim();
    const loadClient = options.loadHostedClient ?? loadLibsqlClient;

    const client = yield* Effect.tryPromise({
      try: () => loadClient(url, authToken === "" ? undefined : authToken),
      catch: (error) =>
        new SqlExecutorError({ reason: `failed to connect to hosted sqlite: ${describe(error)}` }),
    });

    return makeLibsqlExecutor(client);
  });
