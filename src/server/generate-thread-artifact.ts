/**
 * Generate-thread-artifact server function for the Question Learning Thread product.
 *
 * Orchestrates the full thread generation flow:
 * 1. Validate input (question + selected candidates)
 * 2. Look up stored AnswerExcerpts by fingerprint
 * 3. Build timeline stages from candidates + excerpts
 * 4. Call clarification workflow (if not already done)
 * 5. Call synthesis workflow
 * 6. Assemble the final QuestionLearningThread
 * 7. Persist to thread artifact store
 * 8. Return the threadId
 *
 * Credentials are read only in this server wiring module.
 *
 * @module generate-thread-artifact
 */

import { Cause, Effect, Option } from "effect";
import { createServerFn } from "@tanstack/react-start";

import { describeDomainError } from "../lib/domain-error";
import { parseZhihuAnswerUrl } from "../lib/zhihu-answer-url";
import { parseZhihuArticleUrl } from "../lib/zhihu-article-url";
import { makeConfiguredThreadArtifactStore } from "../lib/thread-artifact-store";
import { makeConfiguredExcerptStore } from "../lib/excerpt-store";
import { createQuestionLearningThread } from "../lib/thread-artifact";
import {
  buildEvidenceOnlySynthesis,
  synthesizeThread,
  type SynthesizedNode,
  type ThreadSynthesisResult,
} from "../lib/thread-synthesis";
import { makeFetchOpenAiTransport, makeOpenAiChatCompletions } from "../lib/openai-adapter";
import type { ThreadArtifactStore } from "../lib/thread-artifact-store";
import type { ExcerptStore } from "../lib/excerpt-store";

// ── Response types ─────────────────────────────────────────────────────────────

export type GenerateThreadFailureCode =
  | "INVALID_REQUEST"
  | "CLARIFICATION_FAILED"
  | "SYNTHESIS_FAILED"
  | "ARTIFACT_STORE_FAILURE"
  | "EXCERPT_LOOKUP_FAILED"
  | "MISSING_MODEL_KEY";

export type GenerateThreadResponse =
  | {
      readonly success: true;
      readonly threadId: string;
      readonly mode: "synthesized" | "evidence_only";
    }
  | {
      readonly success: false;
      readonly code: GenerateThreadFailureCode;
      readonly message: string;
    };

// ── Input types ────────────────────────────────────────────────────────────────

export interface GenerateThreadInput {
  readonly question: string;
  readonly refinedQuery: string;
  readonly learningIntent: string;
  readonly confidence: number;
  readonly selectedCandidates: readonly {
    readonly questionId: string;
    readonly answerId: string;
    readonly title: string;
    readonly authorDisplayName: string;
    readonly editTime: number;
    readonly canonicalUrl: string;
    readonly excerptFingerprint: string;
  }[];
}

// ── Handler factory ────────────────────────────────────────────────────────────

export interface GenerateThreadDeps {
  readonly getSecret: () => string | undefined;
  readonly getModel: () => string;
  readonly createExcerptStore: () => Promise<ExcerptStore>;
  readonly createThreadStore: () => Promise<ThreadArtifactStore>;
  readonly createChat: (
    secret: string,
    model: string,
  ) => Promise<ReturnType<typeof makeOpenAiChatCompletions>>;
  /**
   * Server-side failure hook for traces.  The client still receives the
   * generic message; this keeps diagnosis possible without leaking the cause.
   */
  readonly onError?: (error: unknown) => void;
  /** Why model nodes were dropped; server-side diagnosis only. */
  readonly onDiagnostics?: (diagnostics: { readonly rejected: readonly string[] }) => void;
}

export const createGenerateThreadHandler =
  (deps: GenerateThreadDeps) =>
  async (input: GenerateThreadInput): Promise<GenerateThreadResponse> => {
    const question = typeof input?.question === "string" ? input.question.trim() : "";
    const refinedQuery = typeof input?.refinedQuery === "string" ? input.refinedQuery.trim() : "";
    const learningIntent =
      typeof input?.learningIntent === "string" ? input.learningIntent.trim() : "";

    if (question === "" || refinedQuery === "" || learningIntent === "") {
      return {
        success: false as const,
        code: "INVALID_REQUEST",
        message: "请提供完整的问题、澄清查询和学习意图。",
      };
    }

    if (!Array.isArray(input.selectedCandidates) || input.selectedCandidates.length === 0) {
      return {
        success: false as const,
        code: "INVALID_REQUEST",
        message: "请至少选择一个回答候选。",
      };
    }

    const model = deps.getModel();
    const excerptStore = await deps.createExcerptStore();
    const threadStore = await deps.createThreadStore();

    try {
      // Look up stored excerpts for each candidate
      const candidates = input.selectedCandidates;
      const lookups = candidates.map((c) =>
        Effect.runPromise(
          Effect.exit(excerptStore.findLatest(c.questionId, c.answerId)).pipe(
            Effect.catchAll(() =>
              Effect.succeed({ _tag: "Failure" as const, cause: null } as never),
            ),
          ),
        ),
      );

      const lookupResults = await Promise.all(lookups);

      const timelineStagesBuilder: import("../lib/thread-artifact").TimelineStageInput[] = [];
      let foundExcerpts = 0;

      for (let i = 0; i < candidates.length; i++) {
        const result = lookupResults[i] as {
          _tag: string;
          value?: import("../lib/answer-excerpt").AnswerExcerpt;
        };
        if (result._tag !== "Success" || !result.value) {
          continue;
        }

        const candidate = candidates[i];
        const excerpt = result.value;
        foundExcerpts++;

        timelineStagesBuilder.push({
          questionId: excerpt.questionId,
          answerId: excerpt.answerId,
          title: candidate.title,
          authorDisplayName: candidate.authorDisplayName,
          editTime: candidate.editTime,
          canonicalUrl: candidate.canonicalUrl,
          excerpt: {
            questionId: excerpt.questionId,
            answerId: excerpt.answerId,
            capturedAt: excerpt.capturedAt,
            sourceContentId: excerpt.sourceContentId,
            sourceContentType: excerpt.sourceContentType,
            sourceEditTime: excerpt.sourceEditTime,
            excerpt: excerpt.excerpt,
            fingerprint: excerpt.fingerprint,
          },
        });
      }

      if (timelineStagesBuilder.length === 0) {
        return {
          success: false as const,
          code: "EXCERPT_LOOKUP_FAILED",
          message: "未在本地找到任何已缓存的回答摘录，请先搜索并选择候选。",
        };
      }

      // Generate thread ID (opaque, random)
      const threadId = crypto.randomUUID().replace(/-/g, "").slice(0, 16).toLowerCase();
      const timelineStages =
        timelineStagesBuilder as unknown as readonly import("../lib/thread-artifact").TimelineStage[];

      const synthesisInput = {
        question,
        refinedQuery,
        learningIntent,
        timelineStages,
      };
      const secret = deps.getSecret();
      let synthesisResult: ThreadSynthesisResult;
      let synthesisMode: "synthesized" | "evidence_only" = "evidence_only";

      if (typeof secret === "string" && secret.trim() !== "") {
        const chat = await deps.createChat(secret, model);
        // runPromise rejects with an opaque FiberFailure whose cause is not
        // enumerable, which made every synthesis failure look identical in a
        // trace.  Reading the typed exit keeps the reason visible server-side
        // while the client still gets the one generic message.
        const synthesisExit = await Effect.runPromiseExit(
          synthesizeThread({
            model,
            chat,
            ...(deps.onDiagnostics ? { onDiagnostics: deps.onDiagnostics } : {}),
          })(synthesisInput),
        );
        if (synthesisExit._tag === "Failure") {
          const failure = Cause.failureOption(synthesisExit.cause);
          deps.onError?.(new Error(describeDomainError(Option.getOrNull(failure))));
          return {
            success: false as const,
            code: "SYNTHESIS_FAILED",
            message: "生成学习线程时出现异常，请稍后再试。",
          };
        }
        synthesisResult = synthesisExit.value;
        // Only claim "synthesized" when the model's own nodes survived
        // validation; a silent fallback to raw excerpts is evidence-only.
        synthesisMode = synthesisResult.source === "model" ? "synthesized" : "evidence_only";
      } else {
        synthesisResult = buildEvidenceOnlySynthesis(synthesisInput);
      }

      // Build learning nodes
      const learningNodesInput = synthesisResult.nodes.map((node: SynthesizedNode) => ({
        kind: node.kind,
        title: node.title,
        summary: node.summary,
        evidenceRefs: node.evidenceRefs.map(
          (ref: { excerptFingerprint: string; quote: string }) => ({
            excerptFingerprint: ref.excerptFingerprint,
            quote: ref.quote,
          }),
        ),
        sourceAnswerId: node.sourceAnswerId,
        sourceUrl: node.sourceUrl,
        uncertainty: node.uncertainty,
      }));

      const learningGuideInput = synthesisResult.learningGuide;

      // Create the thread artifact
      const now = Date.now();
      const artifactInput = {
        threadId,
        question,
        refinedQuery,
        createdAt: now,
        timelineStages: timelineStagesBuilder,
        learningNodes: learningNodesInput,
        learningGuide: learningGuideInput,
        uncertainty: input.confidence,
      };

      const artifactResult = createQuestionLearningThread(artifactInput);
      if (artifactResult._tag === "failure") {
        return {
          success: false as const,
          code: "ARTIFACT_STORE_FAILURE",
          message: "构建学习线程时出现异常，请稍后再试。",
        };
      }

      // Persist the artifact
      await Effect.runPromise(threadStore.save(artifactResult.artifact));

      return {
        success: true,
        threadId: artifactResult.artifact.threadId,
        mode: synthesisMode,
      };
    } catch (error) {
      // Anything left here is a store or artifact-construction defect rather
      // than a model outcome; the synthesis path reports its own typed reason.
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      return {
        success: false as const,
        code: "SYNTHESIS_FAILED",
        message: "生成学习线程时出现异常，请稍后再试。",
      };
    }
  };

// ── Input parser ───────────────────────────────────────────────────────────────

/**
 * A selected candidate is usable when it identifies a stored excerpt: every
 * candidate needs an answer id, and the URL must be one of the two Zhihu source
 * shapes. Column articles carry no question id, so requiring one dropped every
 * article the user selected and produced "select at least one candidate".
 */
const isUsableSelectedCandidate = (candidate: {
  readonly questionId: string;
  readonly answerId: string;
  readonly canonicalUrl: string;
}): boolean => {
  if (candidate.answerId === "") return false;

  if (parseZhihuArticleUrl(candidate.canonicalUrl)._tag === "success") return true;

  return (
    parseZhihuAnswerUrl(candidate.canonicalUrl)._tag === "success" && candidate.questionId !== ""
  );
};

export const parseGenerateThreadInput = (input: unknown): GenerateThreadInput => {
  if (typeof input !== "object" || input === null) {
    return {
      question: "",
      refinedQuery: "",
      learningIntent: "",
      confidence: 0,
      selectedCandidates: [],
    };
  }

  const raw = input as Record<string, unknown>;

  const question = typeof raw.question === "string" ? raw.question : "";
  const refinedQuery = typeof raw.refinedQuery === "string" ? raw.refinedQuery : "";
  const learningIntent = typeof raw.learningIntent === "string" ? raw.learningIntent : "";
  const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;

  let selectedCandidates: GenerateThreadInput["selectedCandidates"] = [];
  if (Array.isArray(raw.selectedCandidates)) {
    selectedCandidates = raw.selectedCandidates
      .filter(
        (c): c is Record<string, unknown> =>
          typeof c === "object" && c !== null && !Array.isArray(c),
      )
      .map((c) => ({
        questionId: typeof c.questionId === "string" ? c.questionId : "",
        answerId: typeof c.answerId === "string" ? c.answerId : "",
        title: typeof c.title === "string" ? c.title : "",
        authorDisplayName: typeof c.authorDisplayName === "string" ? c.authorDisplayName : "",
        editTime: typeof c.editTime === "number" ? c.editTime : 0,
        canonicalUrl: typeof c.canonicalUrl === "string" ? c.canonicalUrl : "",
        excerptFingerprint: typeof c.excerptFingerprint === "string" ? c.excerptFingerprint : "",
      }))
      .filter(isUsableSelectedCandidate);
  }

  return { question, refinedQuery, learningIntent, confidence, selectedCandidates };
};

// ── Chat creation helper ───────────────────────────────────────────────────────

const DEFAULT_MODEL = "gpt-4o-mini";

// ── Production wiring ──────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

let excerptStoreSingleton: Promise<ExcerptStore> | null = null;
let threadStoreSingleton: Promise<ThreadArtifactStore> | null = null;

const getOrCreateExcerptStoreInstance = async (): Promise<ExcerptStore> => {
  if (!excerptStoreSingleton) {
    excerptStoreSingleton = Effect.runPromise(makeConfiguredExcerptStore());
  }
  return excerptStoreSingleton;
};

const getOrCreateThreadStoreInstance = async (): Promise<ThreadArtifactStore> => {
  if (!threadStoreSingleton) {
    threadStoreSingleton = Effect.runPromise(makeConfiguredThreadArtifactStore());
  }
  return threadStoreSingleton;
};

const createChatWrapper = async (secret: string, model: string) =>
  makeOpenAiChatCompletions({
    apiKey: secret,
    model,
    transport: makeFetchOpenAiTransport({ timeoutMs: "90 seconds" }),
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    timeoutMs: "90 seconds",
  });

export const generateThreadArtifactFn = createServerFn({ method: "POST" })
  .validator(parseGenerateThreadInput)
  .handler(async ({ data }): Promise<GenerateThreadResponse> => {
    return createGenerateThreadHandler({
      getSecret: () => OPENAI_API_KEY,
      getModel: () => OPENAI_MODEL,
      createExcerptStore: getOrCreateExcerptStoreInstance,
      createThreadStore: getOrCreateThreadStoreInstance,
      createChat: createChatWrapper,
    })(data);
  });
