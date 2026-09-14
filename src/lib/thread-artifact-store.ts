import { Data, Effect } from "effect";

import { makeBetterSqliteExecutor, makeSqlExecutor, type SqlExecutor } from "./sql-executor";
import { createQuestionLearningThread } from "./thread-artifact";
import type {
  LearningGuideInput,
  LearningNodeInput,
  QuestionLearningThread,
  TimelineStageInput,
} from "./thread-artifact";

// ── Errors ─────────────────────────────────────────────────────────────────────

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly reason: string;
}> {}

// ── Interface ──────────────────────────────────────────────────────────────────

export interface ThreadArtifactStore {
  readonly save: (artifact: QuestionLearningThread) => Effect.Effect<void, StoreError>;
  readonly findById: (threadId: string) => Effect.Effect<QuestionLearningThread | null, StoreError>;
}

// ── SQL ────────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS thread_artifacts (
  thread_id     TEXT    NOT NULL,
  question      TEXT    NOT NULL,
  refined_query TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  artifact_json TEXT    NOT NULL,
  fingerprint   TEXT    NOT NULL,
  created_at_db INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (thread_id, fingerprint)
);
`;

const INSERT_OR_IGNORE_SQL = `
INSERT OR IGNORE INTO thread_artifacts
  (thread_id, question, refined_query, created_at, artifact_json, fingerprint)
VALUES
  (?, ?, ?, ?, ?, ?);
`;

const FIND_BY_ID_SQL = `
SELECT thread_id, question, refined_query, created_at, artifact_json, fingerprint
FROM thread_artifacts
WHERE thread_id = ?;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Rebuild a stored row through the domain factory. Any row that fails the
 * current contract is reported as a store error instead of reaching React.
 */
const decodeRow = (row: Record<string, unknown>): QuestionLearningThread => {
  const parsed: unknown = JSON.parse(String(row.artifact_json));
  if (!isRecord(parsed)) {
    throw new Error("artifact_json is not an object");
  }

  if (parsed.threadId !== String(row.thread_id)) {
    throw new Error("threadId mismatch");
  }
  if (parsed.fingerprint !== String(row.fingerprint)) {
    throw new Error("fingerprint mismatch");
  }

  const result = createQuestionLearningThread({
    threadId: String(row.thread_id),
    question: String(row.question),
    refinedQuery: String(row.refined_query),
    createdAt: Number(row.created_at),
    timelineStages: Array.isArray(parsed.timelineStages)
      ? (parsed.timelineStages as readonly TimelineStageInput[])
      : [],
    learningNodes: Array.isArray(parsed.learningNodes)
      ? (parsed.learningNodes as readonly LearningNodeInput[])
      : [],
    learningGuide: isRecord(parsed.learningGuide)
      ? (parsed.learningGuide as unknown as LearningGuideInput)
      : undefined,
    uncertainty: typeof parsed.uncertainty === "number" ? parsed.uncertainty : 0,
  });

  if (result._tag === "failure") {
    throw new Error(`invalid stored artifact: ${result.reason}`);
  }

  return result.artifact;
};

// ── Store ──────────────────────────────────────────────────────────────────────

/**
 * Build the thread artifact store on top of any {@link SqlExecutor}: a local
 * SQLite file in development, a hosted libSQL database when configured.
 */
export const makeThreadArtifactStore = (
  database: SqlExecutor,
): Effect.Effect<ThreadArtifactStore, StoreError> =>
  Effect.gen(function* () {
    yield* attempt("schema migration failed", () => database.exec(SCHEMA_SQL));

    const save = (artifact: QuestionLearningThread): Effect.Effect<void, StoreError> =>
      attempt("save failed", () =>
        database.run(INSERT_OR_IGNORE_SQL, [
          artifact.threadId,
          artifact.question,
          artifact.refinedQuery,
          artifact.createdAt,
          JSON.stringify(artifact),
          artifact.fingerprint,
        ]),
      ).pipe(Effect.map(() => undefined));

    const findById = (threadId: string): Effect.Effect<QuestionLearningThread | null, StoreError> =>
      attempt("findById failed", async () => {
        const row = await database.get<Record<string, unknown>>(FIND_BY_ID_SQL, [threadId]);
        return row ? decodeRow(row) : null;
      });

    return { save, findById };
  });

/**
 * Local-only factory. Tests and local tooling must never reach a hosted
 * database just because the environment happens to configure one.
 */
export const makeSqliteThreadArtifactStore = (
  dbPath = DEFAULT_DB_PATH,
): Effect.Effect<ThreadArtifactStore, StoreError> =>
  makeBetterSqliteExecutor(dbPath).pipe(
    Effect.flatMap(makeThreadArtifactStore),
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ reason: error.reason }),
    ),
  );

/**
 * Server-side factory: hosted libSQL when `TURSO_DATABASE_URL` is set,
 * otherwise a local SQLite file at `dbPath`.
 */
export const makeConfiguredThreadArtifactStore = (
  dbPath = DEFAULT_DB_PATH,
): Effect.Effect<ThreadArtifactStore, StoreError> =>
  makeSqlExecutor({ dbPath }).pipe(
    Effect.flatMap(makeThreadArtifactStore),
    Effect.mapError((error) =>
      error instanceof StoreError ? error : new StoreError({ reason: error.reason }),
    ),
  );
