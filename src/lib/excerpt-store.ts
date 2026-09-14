import { Data, Effect } from "effect";

import type { AnswerExcerpt } from "./answer-excerpt";
import { makeBetterSqliteExecutor, makeSqlExecutor, type SqlExecutor } from "./sql-executor";

// ── Errors ─────────────────────────────────────────────────────────────────────

/**
 * Tagged error for all store-level failures (open, read, write, schema).
 */
export class StoreError extends Data.TaggedError("StoreError")<{
  readonly reason: string;
}> {}

// ── Interface ──────────────────────────────────────────────────────────────────

export interface ExcerptStore {
  /** Persist a single excerpt. Duplicate (questionId, answerId, fingerprint) rows are silently ignored. */
  readonly save: (excerpt: AnswerExcerpt) => Effect.Effect<void, StoreError>;
  /** Return the most recent excerpt for the given key, or null if none exist. */
  readonly findLatest: (
    questionId: string,
    answerId: string,
  ) => Effect.Effect<AnswerExcerpt | null, StoreError>;
}

// ── SQL ────────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS excerpts (
  question_id      TEXT    NOT NULL,
  answer_id        TEXT    NOT NULL,
  captured_at      INTEGER NOT NULL,
  source_content_id   TEXT    NOT NULL,
  source_content_type TEXT    NOT NULL,
  source_edit_time    INTEGER NOT NULL,
  excerpt          TEXT    NOT NULL,
  fingerprint      TEXT    NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (question_id, answer_id, fingerprint)
);
`;

const INSERT_OR_IGNORE_SQL = `
INSERT OR IGNORE INTO excerpts
  (question_id, answer_id, captured_at, source_content_id, source_content_type, source_edit_time, excerpt, fingerprint)
VALUES
  (?, ?, ?, ?, ?, ?, ?, ?);
`;

const FIND_LATEST_SQL = `
SELECT question_id, answer_id, captured_at, source_content_id, source_content_type, source_edit_time, excerpt, fingerprint
FROM excerpts
WHERE question_id = ? AND answer_id = ?
ORDER BY captured_at DESC
LIMIT 1;
`;

// ── Default DB path helper ─────────────────────────────────────────────────────

const DEFAULT_DB_PATH = process.env.EXCERPT_DB_PATH ?? ".local/excerpts.db";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const attempt = <A>(reason: string, run: () => Promise<A>): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new StoreError({ reason: `${reason}: ${describe(error)}` }),
  });

// ── Store ──────────────────────────────────────────────────────────────────────

/**
 * Build the excerpt store on top of any {@link SqlExecutor}: a local SQLite
 * file in development, a hosted libSQL database when one is configured.
 */
export const makeExcerptStore = (database: SqlExecutor): Effect.Effect<ExcerptStore, StoreError> =>
  Effect.gen(function* () {
    yield* attempt("schema migration failed", () => database.exec(SCHEMA_SQL));

    const save = (excerpt: AnswerExcerpt): Effect.Effect<void, StoreError> =>
      attempt("save failed", () =>
        database.run(INSERT_OR_IGNORE_SQL, [
          excerpt.questionId,
          excerpt.answerId,
          excerpt.capturedAt,
          excerpt.sourceContentId,
          excerpt.sourceContentType,
          excerpt.sourceEditTime,
          excerpt.excerpt,
          excerpt.fingerprint,
        ]),
      ).pipe(Effect.map(() => undefined));

    const findLatest = (
      questionId: string,
      answerId: string,
    ): Effect.Effect<AnswerExcerpt | null, StoreError> =>
      attempt("findLatest failed", async () => {
        const row = await database.get<Record<string, unknown>>(FIND_LATEST_SQL, [
          questionId,
          answerId,
        ]);
        if (!row) return null;

        return {
          questionId: String(row.question_id),
          answerId: String(row.answer_id),
          capturedAt: Number(row.captured_at),
          sourceContentId: String(row.source_content_id),
          sourceContentType: row.source_content_type as AnswerExcerpt["sourceContentType"],
          sourceEditTime: Number(row.source_edit_time),
          excerpt: String(row.excerpt),
          fingerprint: String(row.fingerprint),
        } satisfies AnswerExcerpt;
      });

    return { save, findLatest };
  });

/**
 * Local-only factory. Tests and local tooling must never reach a hosted
 * database just because the environment happens to configure one.
 */
export const makeSqliteExcerptStore = (
  dbPath = DEFAULT_DB_PATH,
): Effect.Effect<ExcerptStore, StoreError> =>
  makeBetterSqliteExecutor(dbPath).pipe(
    Effect.flatMap(makeExcerptStore),
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ reason: error.reason }),
    ),
  );

/**
 * Server-side factory: hosted libSQL when `TURSO_DATABASE_URL` is set,
 * otherwise a local SQLite file at `dbPath`.
 */
export const makeConfiguredExcerptStore = (
  dbPath = DEFAULT_DB_PATH,
): Effect.Effect<ExcerptStore, StoreError> =>
  makeSqlExecutor({ dbPath }).pipe(
    Effect.flatMap(makeExcerptStore),
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ reason: error.reason }),
    ),
  );
