import { Effect } from "effect";

import type { DailyQuotaOutcome, DailyQuotaStore } from "./daily-quota";
import { DailyQuotaStoreError } from "./daily-quota";
import { makeSqlExecutor, type SqlExecutor } from "./sql-executor";

// ── SQL ───────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_quota_usage (
  provider   TEXT    NOT NULL,
  quota_day  TEXT    NOT NULL,
  used_count INTEGER NOT NULL CHECK (used_count >= 0),
  PRIMARY KEY (provider, quota_day)
);
`;

/**
 * Reserve one attempt in a single atomic statement: the row is created on the
 * first call of the day and only incremented while usage is below the limit.
 * Zero changed rows therefore means "exhausted", and the counter never advances
 * past the limit.
 */
const RESERVE_SQL = `
INSERT INTO provider_quota_usage (provider, quota_day, used_count)
VALUES (?, ?, 1)
ON CONFLICT (provider, quota_day) DO UPDATE
  SET used_count = used_count + 1
  WHERE used_count < ?;
`;

// ── Default DB path ───────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = process.env.QUOTA_DB_PATH ?? ".local/provider-quota.db";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const attempt = <A>(
  reason: string,
  run: () => Promise<A>,
): Effect.Effect<A, DailyQuotaStoreError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new DailyQuotaStoreError({ reason: `${reason}: ${describe(error)}` }),
  });

// ── Store ─────────────────────────────────────────────────────────────────────

/** Build the quota store on top of any {@link SqlExecutor}. */
export const makeDailyQuotaStore = (
  database: SqlExecutor,
): Effect.Effect<DailyQuotaStore, DailyQuotaStoreError> =>
  Effect.gen(function* () {
    yield* attempt("schema migration failed", () => database.exec(SCHEMA_SQL));

    const reserve = (
      provider: string,
      quotaDay: string,
      limit: number,
    ): Effect.Effect<DailyQuotaOutcome, DailyQuotaStoreError> =>
      limit > 0
        ? attempt("reserve failed", async () => {
            const changed = await database.run(RESERVE_SQL, [provider, quotaDay, limit]);
            return changed > 0 ? "allowed" : "exhausted";
          })
        : // A zero limit means no attempt is allowed, so no row is written.
          Effect.succeed("exhausted" as const);

    return { reserve };
  });

/**
 * Create the quota store described by the environment: hosted libSQL when
 * `TURSO_DATABASE_URL` is set, otherwise a local SQLite file at `dbPath`.
 */
export const makeSqliteDailyQuotaStore = (
  dbPath = DEFAULT_DB_PATH,
): Effect.Effect<DailyQuotaStore, DailyQuotaStoreError> =>
  makeSqlExecutor({ dbPath }).pipe(
    Effect.flatMap(makeDailyQuotaStore),
    Effect.mapError((error) =>
      error instanceof DailyQuotaStoreError
        ? error
        : new DailyQuotaStoreError({ reason: error.reason }),
    ),
  );
