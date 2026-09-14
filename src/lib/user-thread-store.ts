/**
 * Per-user learning-thread collection.
 *
 * Only membership lives here: the thread artifact keeps its own row, so a
 * collection is a pointer plus the summary a workspace card needs. Rows are
 * keyed by the Zhihu user id, which makes the workspace follow the account
 * instead of the browser.
 *
 * @module user-thread-store
 */

import { Data, Effect } from "effect";

import { makeBetterSqliteExecutor, makeSqlExecutor, type SqlExecutor } from "./sql-executor";
import type { CollectedThreadSummary } from "./thread-collection";

// ── Errors ─────────────────────────────────────────────────────────────────────

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly reason: string;
}> {}

// ── Interface ──────────────────────────────────────────────────────────────────

export interface UserThreadStore {
  readonly list: (userId: string) => Effect.Effect<readonly CollectedThreadSummary[], StoreError>;
  readonly save: (
    userId: string,
    summary: CollectedThreadSummary,
  ) => Effect.Effect<void, StoreError>;
  readonly remove: (userId: string, threadId: string) => Effect.Effect<void, StoreError>;
}

// ── SQL ────────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_thread_collections (
  user_id      TEXT    NOT NULL,
  thread_id    TEXT    NOT NULL,
  question     TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  node_count   INTEGER NOT NULL,
  year_range   TEXT    NOT NULL,
  saved_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, thread_id)
);
`;

const UPSERT_SQL = `
INSERT INTO user_thread_collections
  (user_id, thread_id, question, created_at, source_count, node_count, year_range, saved_at)
VALUES
  (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, thread_id) DO UPDATE SET
  question     = excluded.question,
  created_at   = excluded.created_at,
  source_count = excluded.source_count,
  node_count   = excluded.node_count,
  year_range   = excluded.year_range,
  saved_at     = excluded.saved_at;
`;

const LIST_SQL = `
SELECT thread_id, question, created_at, source_count, node_count, year_range
FROM user_thread_collections
WHERE user_id = ?
ORDER BY saved_at DESC
LIMIT 200;
`;

const REMOVE_SQL = `
DELETE FROM user_thread_collections
WHERE user_id = ? AND thread_id = ?;
`;

// ── Default DB path ────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = process.env.DATABASE_PATH ?? ".local/thread-artifacts.db";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const attempt = <A>(reason: string, run: () => Promise<A>): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new StoreError({ reason: `${reason}: ${describe(error)}` }),
  });

// ── Store ──────────────────────────────────────────────────────────────────────

/** Build the collection store on top of any {@link SqlExecutor}. */
export const makeUserThreadStore = (
  database: SqlExecutor,
): Effect.Effect<UserThreadStore, StoreError> =>
  Effect.gen(function* () {
    yield* attempt("schema migration failed", () => database.exec(SCHEMA_SQL));

    const list = (userId: string): Effect.Effect<readonly CollectedThreadSummary[], StoreError> =>
      attempt("list failed", async () => {
        const rows = await database.all<Record<string, unknown>>(LIST_SQL, [userId]);
        return rows.map((row): CollectedThreadSummary => ({
          threadId: String(row.thread_id),
          question: String(row.question),
          createdAt: Number(row.created_at),
          sourceCount: Number(row.source_count),
          nodeCount: Number(row.node_count),
          yearRange: String(row.year_range),
        }));
      });

    const save = (
      userId: string,
      summary: CollectedThreadSummary,
    ): Effect.Effect<void, StoreError> =>
      attempt("save failed", async () => {
        await database.run(UPSERT_SQL, [
          userId,
          summary.threadId,
          summary.question,
          summary.createdAt,
          summary.sourceCount,
          summary.nodeCount,
          summary.yearRange,
          Date.now(),
        ]);
      });

    const remove = (userId: string, threadId: string): Effect.Effect<void, StoreError> =>
      attempt("remove failed", async () => {
        await database.run(REMOVE_SQL, [userId, threadId]);
      });

    return { list, save, remove };
  });

/**
 * Local-only factory. Tests and local tooling must never reach a hosted
 * database just because the environment happens to configure one.
 */
export const makeSqliteUserThreadStore = (
  dbPath = DEFAULT_DB_PATH,
): Effect.Effect<UserThreadStore, StoreError> =>
  makeBetterSqliteExecutor(dbPath).pipe(
    Effect.flatMap(makeUserThreadStore),
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ reason: error.reason }),
    ),
  );

/**
 * Server-side factory: hosted libSQL when `TURSO_DATABASE_URL` is set,
 * otherwise a local SQLite file at `dbPath`.
 */
export const makeConfiguredUserThreadStore = (
  dbPath = DEFAULT_DB_PATH,
): Effect.Effect<UserThreadStore, StoreError> =>
  makeSqlExecutor({ dbPath }).pipe(
    Effect.flatMap(makeUserThreadStore),
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ reason: error.reason }),
    ),
  );
