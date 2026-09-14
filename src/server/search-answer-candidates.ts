import { Effect } from "effect";
import { createServerFn } from "@tanstack/react-start";

import { parseZhihuAnswerUrl } from "../lib/zhihu-answer-url";
import { parseZhihuArticleUrl } from "../lib/zhihu-article-url";
import {
  fetchSearchItems,
  makeFetchSearchTransport,
  SearchError,
  SearchTransportError,
} from "../lib/zhihu-content-search";

import { createAnswerExcerpt } from "../lib/answer-excerpt";
import type { AnswerExcerpt } from "../lib/answer-excerpt";

import { buildQueryVariants } from "../lib/search-query-variants";

import { makeConfiguredExcerptStore, type ExcerptStore } from "../lib/excerpt-store";
import { StoreError } from "../lib/excerpt-store";

import { makeConfiguredDailyQuotaStore } from "../lib/sqlite-daily-quota-store";

import { makeDailyQuotaGuard, QuotaExceededError, type DailyQuotaGuard } from "../lib/daily-quota";

// ═══════════════════════════════════════════════════════════════════════════════
// JSON-safe types
// ═══════════════════════════════════════════════════════════════════════════════

export interface AnswerCandidate {
  readonly questionId: string;
  readonly answerId: string;
  /** What kind of Zhihu content this is; drives the source badge in the UI. */
  readonly sourceContentType: "Answer" | "Article";
  readonly title: string;
  readonly url: string;
  readonly preview: string;
  readonly excerptFingerprint: string;
  readonly authorDisplayName?: string;
  readonly editAt?: number;
}

export type SearchAnswerCandidatesResponse =
  | {
      readonly status: "ok";
      readonly candidates: readonly AnswerCandidate[];
    }
  | {
      readonly status: "error";
      readonly code: SearchCandidatesFailureCode;
      readonly message: string;
    };

export type SearchCandidatesFailureCode =
  | "INVALID_REQUEST"
  | "MISSING_ACCESS_SECRET"
  | "SEARCH_RATE_LIMITED"
  | "SEARCH_QUOTA_EXCEEDED"
  | "SEARCH_EXCERPT_STORE_FAILURE"
  | "SEARCH_ERROR";

const MESSAGES: Record<SearchCandidatesFailureCode, string> = {
  INVALID_REQUEST: "请输入搜索关键词。",
  MISSING_ACCESS_SECRET: "知乎访问密钥未配置。",
  SEARCH_RATE_LIMITED: "搜索请求频率过高，请稍后再试。",
  SEARCH_QUOTA_EXCEEDED: "搜索配额已用完。",
  SEARCH_EXCERPT_STORE_FAILURE: "摘要存储失败，请稍后再试。",
  SEARCH_ERROR: "搜索失败，请稍后再试。",
};

const safeErrorResponse = (code: SearchCandidatesFailureCode): SearchAnswerCandidatesResponse => ({
  status: "error",
  code,
  message: MESSAGES[code],
});

// ═══════════════════════════════════════════════════════════════════════════════
// Item processing — extract candidate display fields and build AnswerExcerpts
// ═══════════════════════════════════════════════════════════════════════════════

interface SearchProcessingResult {
  readonly candidates: readonly AnswerCandidate[];
  readonly excerpts: AnswerExcerpt[];
}

function processSearchItems(items: readonly unknown[], now: number): SearchProcessingResult {
  const seen = new Set<string>();
  const candidates: AnswerCandidate[] = [];
  const excerpts: AnswerExcerpt[] = [];

  for (const item of items) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (typeof item !== "object" || item === null) continue;

    const record = item as Record<string, unknown>;
    const rawUrl = typeof record.Url === "string" ? record.Url : undefined;
    if (!rawUrl) continue;

    // Articles are first-class results of this endpoint and, for the technical
    // concepts this product teaches, they carry most of the vocabulary.
    const contentType = typeof record.ContentType === "string" ? record.ContentType : "";
    if (contentType !== "Answer" && contentType !== "Article") continue;

    let questionId = "";
    let sourceId: string;
    let canonicalUrl: string;
    const kind = contentType as "Answer" | "Article";
    if (contentType === "Answer") {
      const parsed = parseZhihuAnswerUrl(rawUrl);
      if (parsed._tag !== "success") continue;
      questionId = parsed.questionId;
      sourceId = parsed.answerId;
      canonicalUrl = parsed.canonicalUrl;
    } else {
      const parsed = parseZhihuArticleUrl(rawUrl);
      if (parsed._tag !== "success") continue;
      sourceId = parsed.articleId;
      canonicalUrl = parsed.canonicalUrl;
    }

    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    // Malformed items are silently skipped, not converted into invalid excerpts.
    const contentId = record.ContentID;
    const editTime = record.EditTime;
    const contentText =
      typeof record.ContentText === "string" && record.ContentText.trim() !== ""
        ? record.ContentText
        : undefined;

    const isValidForExcerpt =
      typeof contentId === "string" &&
      /^(?:0|-?[1-9][0-9]*)$/.test(contentId) &&
      typeof editTime === "number" &&
      Number.isSafeInteger(editTime) &&
      editTime >= 0 &&
      contentText !== undefined;

    let excerpt: AnswerExcerpt | undefined;
    if (isValidForExcerpt) {
      const result = createAnswerExcerpt({
        questionId,
        answerId: sourceId,
        capturedAt: now,
        sourceContentId: contentId,
        sourceContentType: kind,
        sourceEditTime: editTime,
        excerpt: contentText, // createAnswerExcerpt normalizes and strips <em>
      });

      excerpt = result._tag === "success" ? result.excerpt : undefined;
    }

    if (!excerpt) continue;

    excerpts.push(excerpt);
    candidates.push({
      questionId,
      answerId: sourceId,
      sourceContentType: kind,
      title: typeof record.Title === "string" ? record.Title.trim() : "",
      url: canonicalUrl,
      preview: excerpt.excerpt.slice(0, 200),
      excerptFingerprint: excerpt.fingerprint,
      authorDisplayName:
        typeof record.AuthorName === "string" && record.AuthorName.trim() !== ""
          ? record.AuthorName.trim()
          : undefined,
      editAt:
        typeof record.EditTime === "number" &&
        Number.isSafeInteger(record.EditTime) &&
        record.EditTime >= 0
          ? record.EditTime
          : undefined,
    });
  }

  return { candidates, excerpts };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler factory (testable — receives injected dependencies)
// ═══════════════════════════════════════════════════════════════════════════════

export interface SearchAnswerCandidatesInput {
  readonly query: string;
  /**
   * Clarified alternative phrasings of the same need. They are only searched
   * when the primary query comes back thin, so a learning thread can still
   * reach several years of answers instead of stopping at one excerpt.
   */
  readonly altQueries?: readonly string[];
}

const MAX_CANDIDATES = 5;

// Below this the "thread" is really a single source, so broadening is worth a
// second search.
const MIN_USEFUL_CANDIDATES = 3;
const MAX_ALT_QUERIES = 3;

export interface SearchAnswerCandidatesDeps {
  readonly getSecret: () => string | undefined;
  /** Create a fresh excerpt store. */
  readonly createStore: () => Promise<ExcerptStore>;
  /** Create a daily quota guard. */
  readonly createQuotaGuard: () => Promise<DailyQuotaGuard>;
  /**
   * Observability hook for the query forms actually dispatched.  Server-side
   * only: it never reaches the client response, and it exists so an eval trace
   * can tell a retrieval gap apart from a synthesis gap.
   */
  readonly onSearchAttempt?: (attempt: SearchAttemptRecord) => void;
}

export interface SearchAttemptRecord {
  readonly query: string;
  readonly ok: boolean;
  readonly candidates: number;
}

/** Failures that cannot recover within a single request. */
const isTerminalFailure = (error: unknown): boolean =>
  (error instanceof SearchError &&
    (error.reason === "API_RATE_LIMITED" || error.reason === "API_QUOTA_EXCEEDED")) ||
  (error instanceof SearchTransportError && error.reason === "HTTP_STATUS" && error.status === 429);

const failureCode = (error: unknown): SearchCandidatesFailureCode => {
  if (error instanceof SearchError) {
    if (error.reason === "API_RATE_LIMITED") return "SEARCH_RATE_LIMITED";
    if (error.reason === "API_QUOTA_EXCEEDED") return "SEARCH_QUOTA_EXCEEDED";
  }
  if (
    error instanceof SearchTransportError &&
    error.reason === "HTTP_STATUS" &&
    error.status === 429
  ) {
    return "SEARCH_RATE_LIMITED";
  }
  return "SEARCH_ERROR";
};

export const createSearchAnswerCandidatesHandler =
  (deps: SearchAnswerCandidatesDeps) =>
  async (input: SearchAnswerCandidatesInput): Promise<SearchAnswerCandidatesResponse> => {
    if (typeof input?.query !== "string" || input.query.trim() === "") {
      return safeErrorResponse("INVALID_REQUEST");
    }

    const secret = deps.getSecret();
    if (typeof secret !== "string" || secret.trim() === "") {
      return safeErrorResponse("MISSING_ACCESS_SECRET");
    }

    const query = input.query.trim();
    const store = await deps.createStore();
    const quotaGuard = await deps.createQuotaGuard();

    const transport = makeFetchSearchTransport({ timeoutMs: 10_000 });

    // One quota unit per dispatched network request. Quota failures are mapped
    // to SearchError reasons so the error branch below handles them uniformly.
    const runSearch = (searchQuery: string) =>
      Effect.runPromiseExit(
        quotaGuard.consume("zhihu_search").pipe(
          Effect.mapError((error): SearchError => {
            if (error instanceof QuotaExceededError) {
              return new SearchError({ reason: "API_QUOTA_EXCEEDED" });
            }
            // Store-level quota errors are surfaced as a generic search failure.
            return new SearchError({ reason: "NON_ZERO_CODE" });
          }),
          Effect.flatMap(() =>
            fetchSearchItems({
              provider: "zhihu_search",
              query: searchQuery,
              accessSecret: secret,
              transport,
            }),
          ),
        ),
      );

    const now = Date.now();
    const candidates: AnswerCandidate[] = [];
    const excerpts: AnswerExcerpt[] = [];
    const seenAnswerIds = new Set<string>();
    const seenFingerprints = new Set<string>();

    const merge = (batch: SearchProcessingResult): void => {
      for (const candidate of batch.candidates) {
        if (candidates.length >= MAX_CANDIDATES) break;
        if (seenAnswerIds.has(candidate.answerId)) continue;
        seenAnswerIds.add(candidate.answerId);
        candidates.push(candidate);
      }
      for (const excerpt of batch.excerpts) {
        if (seenFingerprints.has(excerpt.fingerprint)) continue;
        seenFingerprints.add(excerpt.fingerprint);
        excerpts.push(excerpt);
      }
    };

    // Zhihu content search is a keyword engine, and the clarified sentence
    // form usually comes back as column articles — which this product cannot
    // cite as an answer.  So the derived keyword forms are searched in order
    // and the pool accumulates across them.  A thin first form costs one more
    // request instead of ending the run with nothing to learn from.
    const variants = buildQueryVariants({
      question: query,
      refinedQuery: query,
      alternatives: input.altQueries ?? [],
    });
    const forms = variants.length > 0 ? variants : [query];

    let firstFailure: unknown = null;
    let successes = 0;

    for (const form of forms) {
      if (candidates.length >= MIN_USEFUL_CANDIDATES) break;
      const exit = await runSearch(form);

      if (exit._tag !== "Success") {
        const searchError = exit.cause._tag === "Fail" ? exit.cause.error : null;
        firstFailure ??= searchError;
        deps.onSearchAttempt?.({ query: form, ok: false, candidates: candidates.length });
        // Rate limit and quota will not recover mid-request; a form that
        // returns nothing useful is not a provider failure either.
        if (isTerminalFailure(searchError)) break;
        continue;
      }

      successes += 1;
      merge(processSearchItems(exit.value, now));
      deps.onSearchAttempt?.({ query: form, ok: true, candidates: candidates.length });
    }

    // Every form failed at the provider. Report the first mapped cause rather
    // than pretending an empty pool is a successful search.
    if (successes === 0) return safeErrorResponse(failureCode(firstFailure));

    // Persist each valid excerpt.  Store failures are collected explicitly —
    // they must not be silently swallowed or mapped to a successful search.
    const storeErrors: StoreError[] = [];
    for (const excerpt of excerpts) {
      const saveExit = await Effect.runPromiseExit(store.save(excerpt));
      if (saveExit._tag === "Failure" && saveExit.cause._tag === "Fail") {
        const err =
          saveExit.cause.error instanceof StoreError
            ? saveExit.cause.error
            : new StoreError({ reason: "save failed" });
        storeErrors.push(err);
      }
    }

    // A candidate is only useful when its reused excerpt is durable.  Do not
    // invite the user into a selection that will miss its excerpt later.
    if (storeErrors.length > 0) {
      return safeErrorResponse("SEARCH_EXCERPT_STORE_FAILURE");
    }

    return { status: "ok", candidates };
  };

// ═══════════════════════════════════════════════════════════════════════════════
// Production wiring (reads process.env only here)
// ═══════════════════════════════════════════════════════════════════════════════

const DAILY_QUOTA_LIMIT_PER_DAY = 1000;

let storeInstance: Promise<ExcerptStore> | null = null;
let quotaGuardInstance: Promise<DailyQuotaGuard> | null = null;

const getOrCreateStore = async (): Promise<ExcerptStore> => {
  if (!storeInstance) {
    storeInstance = Effect.runPromise(makeConfiguredExcerptStore());
  }
  return storeInstance;
};

const getOrCreateQuotaGuard = async (): Promise<DailyQuotaGuard> => {
  if (!quotaGuardInstance) {
    quotaGuardInstance = Effect.runPromise(
      Effect.map(makeConfiguredDailyQuotaStore(".local/provider-quota.db"), (store) =>
        makeDailyQuotaGuard({ store, limitPerDay: DAILY_QUOTA_LIMIT_PER_DAY }),
      ),
    );
  }
  return quotaGuardInstance;
};

const parseInput = (input: unknown): SearchAnswerCandidatesInput => {
  if (typeof input !== "object" || input === null || !("query" in input)) {
    return { query: "" };
  }
  const value = (input as { query: unknown }).query;
  const rawAlt = (input as { altQueries?: unknown }).altQueries;
  const altQueries = Array.isArray(rawAlt)
    ? rawAlt.filter((item): item is string => typeof item === "string").slice(0, MAX_ALT_QUERIES)
    : undefined;
  return {
    query: typeof value === "string" ? value : "",
    ...(altQueries ? { altQueries } : {}),
  };
};

export const searchAnswerCandidates = createServerFn({
  method: "POST",
})
  .validator(parseInput)
  .handler(async ({ data }) => {
    return createSearchAnswerCandidatesHandler({
      getSecret: () => process.env["ZHIHU_ACCESS_SECRET"],
      createStore: getOrCreateStore,
      createQuotaGuard: getOrCreateQuotaGuard,
    })(data);
  });
