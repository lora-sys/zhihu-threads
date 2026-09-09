/** Repository integration. Requires installed project dependencies; not used by the standalone driver. */
import { Effect } from "effect";
import { createClarifyQuestionHandler } from "../../server/clarify-question";
import { createSearchAnswerCandidatesHandler } from "../../server/search-answer-candidates";
import { createRankAnswerCandidatesHandler } from "../../server/rank-answer-candidates";
import { createGenerateThreadHandler } from "../../server/generate-thread-artifact";
import { createReadThreadHandler } from "../../server/read-thread-artifact";
import { createAskThreadAgentHandler } from "../../server/ask-thread-agent";
import { createAnswerExcerpt } from "../../lib/answer-excerpt";
import { createQuestionLearningThread } from "../../lib/thread-artifact";
import { makeSqliteExcerptStore } from "../../lib/excerpt-store";
import { makeSqliteThreadArtifactStore } from "../../lib/thread-artifact-store";
import { makeSqliteDailyQuotaStore } from "../../lib/sqlite-daily-quota-store";
import { makeDailyQuotaGuard } from "../../lib/daily-quota";
import { makeFetchOpenAiTransport, makeOpenAiChatCompletions } from "../../lib/openai-adapter";
import type { Network } from "./network.ts";
import type { Complete } from "./policy.ts";
import type { Bindings } from "./bridge.ts";
import { createBridge } from "./bridge.ts";
import { EvalError } from "./runtime.ts";
export interface ProductConfig {
  root: string;
  model: string;
  baseUrl: string;
  modelKey: string;
  searchSecret: string;
  network: Network;
  fixtureFetch?: typeof fetch;
  evidenceOnly?: boolean;
  judgeModel?: string;
}
export const completeFor = (config: ProductConfig): Complete => (messages, runtime, phase) => config.network.scope(runtime, phase, () => {
  const model = phase === "judge" ? config.judgeModel ?? config.model : config.model;
  const chat = makeOpenAiChatCompletions({ apiKey: config.modelKey, model, baseUrl: config.baseUrl,
    transport: makeFetchOpenAiTransport({ timeoutMs: "60 seconds" }), timeoutMs: "60 seconds" });
  return Effect.runPromise(chat.complete({ model, messages }), { signal: runtime.signal });
}, config.fixtureFetch);
export const createProductPort = async (config: ProductConfig) => {
  const excerpts = await Effect.runPromise(makeSqliteExcerptStore(`${config.root}/excerpts.db`));
  const threads = await Effect.runPromise(makeSqliteThreadArtifactStore(`${config.root}/threads.db`));
  const quotaStore = await Effect.runPromise(makeSqliteDailyQuotaStore(`${config.root}/quota.db`));
  const quota = makeDailyQuotaGuard({ store: quotaStore, limitPerDay: 100 });
  const diagnostics: string[] = [];
  const onError = (error: unknown) => { diagnostics.push(error instanceof Error ? error.message : "Product error"); };
  const chat = (timeoutMs: "30 seconds" | "60 seconds" | "90 seconds") => async (key: string, model: string) => makeOpenAiChatCompletions({
    apiKey: key, model, baseUrl: config.baseUrl, transport: makeFetchOpenAiTransport({ timeoutMs }), timeoutMs,
  });
  const common = { getSecret: () => config.modelKey, getModel: () => config.model };
  const bindings: Bindings = {
    diagnostics,
    seed: async (input) => {
      const sources = input.sources ?? input.artifact?.sources ?? [];
      const snapshots = [];
      for (const source of sources) {
        if (source.kind !== "Answer" && source.kind !== "Article")
          throw new EvalError("FIXTURE_SOURCE_KIND_REQUIRED");
        if (source.capturedAt === undefined || source.editTime === undefined || !source.contentId)
          throw new EvalError("FIXTURE_METADATA_REQUIRED");
        const parsed = createAnswerExcerpt({ questionId: source.questionId ?? "", answerId: source.id, capturedAt: source.capturedAt,
          sourceContentId: source.contentId, sourceContentType: source.kind, sourceEditTime: source.editTime, excerpt: source.text });
        if (parsed._tag !== "success" || parsed.excerpt.fingerprint !== source.fingerprint)
          throw new EvalError("FIXTURE_FINGERPRINT_MISMATCH");
        await Effect.runPromise(excerpts.save(parsed.excerpt));
        snapshots.push(parsed.excerpt);
      }
      if (input.artifact) {
        const native = createQuestionLearningThread({ threadId: input.artifact.id, question: input.question, refinedQuery: input.question, createdAt: 1,
          timelineStages: sources.map((s, index) => ({ questionId: s.questionId ?? "", answerId: s.id, title: s.title ?? input.question,
            authorDisplayName: s.author ?? "知乎用户", editTime: s.editTime!, canonicalUrl: s.url, excerpt: snapshots[index] })),
          learningNodes: input.artifact.units.filter((u) => u.kind === "claim").map((u) => ({ kind: "relationship", title: u.id, summary: u.text,
            sourceAnswerId: u.primarySource?.id ?? u.citations[0]?.sourceId ?? "", sourceUrl: u.primarySource?.url ?? u.citations[0]?.url ?? "",
            evidenceRefs: u.citations.map((r) => ({ excerptFingerprint: r.fingerprint, quote: r.quote })), uncertainty: 0.5 })), uncertainty: 0.5 });
        if (native._tag !== "success")
          throw new EvalError("INVALID_FIXED_THREAD");
        await Effect.runPromise(threads.save(native.artifact));
      }
    },
    clarify: createClarifyQuestionHandler({ ...common, createChat: chat("30 seconds"), onError }),
    search: createSearchAnswerCandidatesHandler({ getSecret: () => config.searchSecret, createStore: async () => excerpts, createQuotaGuard: async () => quota }),
    rank: createRankAnswerCandidatesHandler({ ...common, createChat: chat("30 seconds"), onError }),
    generate: createGenerateThreadHandler({ ...common, getSecret: () => config.evidenceOnly ? undefined : config.modelKey,
      createChat: chat("90 seconds"), createExcerptStore: async () => excerpts, createThreadStore: async () => threads, onError }),
    read: createReadThreadHandler({ createThreadStore: async () => threads }),
    ask: createAskThreadAgentHandler({ ...common, createChat: chat("60 seconds"), createThreadStore: async () => threads }),
    excerpt: (questionId, answerId) => Effect.runPromise(excerpts.findLatest(questionId, answerId)),
  };
  return createBridge(bindings, config.network, completeFor(config), config.fixtureFetch);
};
