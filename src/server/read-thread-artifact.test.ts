import { Effect } from "effect";

import { describe, expect, it } from "vite-plus/test";

import type { QuestionLearningThread } from "../lib/thread-artifact";
import { StoreError, type ThreadArtifactStore } from "../lib/thread-artifact-store";

import {
  type ReadThreadResponse,
  type ReadThreadDeps,
  createReadThreadHandler,
} from "./read-thread-artifact";

// ── Helpers ──────────────────────────────────────────────────────────────

const VALID_THREAD_ID = "a1b2c3d4e5f6a7b8";

const makeArtifact = (overrides: Partial<QuestionLearningThread> = {}): QuestionLearningThread => ({
  threadId: VALID_THREAD_ID,
  question: "How do things relate?",
  refinedQuery: "zhihu how things relate",
  createdAt: 1_700_000_000_000,
  timelineStages: [],
  learningNodes: [],
  learningGuide: {
    overview: {
      headline: "Fallback guide",
      summary: "No guide available.",
      evidenceRefs: [],
    },
    stages: [],
    openQuestions: [],
  },
  uncertainty: 0.3,
  fingerprint: "v1:1234567890abcdef",
  ...overrides,
});

const makeStore = (artifact: QuestionLearningThread | null): ThreadArtifactStore => ({
  save: () => Effect.void,
  findById: () => (artifact !== null ? Effect.succeed(artifact) : Effect.succeed(null)),
});

const makeFindByIdThrows = (): ThreadArtifactStore => ({
  save: () => Effect.void,
  findById: () => Effect.fail(new StoreError({ reason: "database locked" })),
});

const buildHandler = (
  overrides: Partial<ReadThreadDeps> = {},
): ReturnType<typeof createReadThreadHandler> => {
  const deps: ReadThreadDeps = {
    createThreadStore: async () => makeStore(makeArtifact()),
    ...overrides,
  };
  return createReadThreadHandler(deps);
};

const runHandler = async (
  handler: ReturnType<typeof createReadThreadHandler>,
  input: { threadId: string },
): Promise<ReadThreadResponse> => handler(input);

const assertFailure = (
  result: ReadThreadResponse,
): { readonly success: false; readonly code: string; readonly message: string } => {
  if (result.success) {
    throw new Error("Expected failure response");
  }
  return result;
};

// ── createReadThreadHandler ──────────────────────────────────────────────

describe("read-thread-artifact createReadThreadHandler", () => {
  it("returns the artifact on success when the store finds it", async () => {
    const artifact = makeArtifact({ question: "Found artifact" });
    const handler = buildHandler({
      createThreadStore: async () => makeStore(artifact),
    });

    const result = await runHandler(handler, { threadId: VALID_THREAD_ID });
    expect(result.success).toBe(true);
    expect((result as { success: true; artifact: QuestionLearningThread }).artifact.question).toBe(
      "Found artifact",
    );
  });

  it("returns ARTIFACT_NOT_FOUND when the store returns null", async () => {
    const handler = buildHandler({
      createThreadStore: async () => makeStore(null),
    });

    const result = await runHandler(handler, { threadId: VALID_THREAD_ID });
    expect(result.success).toBe(false);
    const failure = assertFailure(result);
    expect(failure.code).toBe("ARTIFACT_NOT_FOUND");
    expect(failure.message).toBe("该学习线程不存在或已被移除。");
  });

  it("serves a shipped featured artifact when the database has no row", async () => {
    const featured = makeArtifact({ threadId: VALID_THREAD_ID, question: "Shipped thread" });
    const handler = buildHandler({
      createThreadStore: async () => makeStore(null),
      findFallbackArtifact: (threadId) => (threadId === VALID_THREAD_ID ? featured : null),
    });

    const result = await runHandler(handler, { threadId: VALID_THREAD_ID });
    expect(result.success).toBe(true);
    expect((result as { success: true; artifact: QuestionLearningThread }).artifact.question).toBe(
      "Shipped thread",
    );
  });

  it("prefers the stored artifact over the shipped fallback", async () => {
    const stored = makeArtifact({ question: "Stored thread" });
    const handler = buildHandler({
      createThreadStore: async () => makeStore(stored),
      findFallbackArtifact: () => makeArtifact({ question: "Shipped thread" }),
    });

    const result = await runHandler(handler, { threadId: VALID_THREAD_ID });
    expect(result.success).toBe(true);
    expect((result as { success: true; artifact: QuestionLearningThread }).artifact.question).toBe(
      "Stored thread",
    );
  });

  it("returns ARTIFACT_NOT_FOUND for a non-existent thread ID", async () => {
    let lastId: string | undefined;
    const handler = buildHandler({
      createThreadStore: async () => ({
        save: () => Effect.void,
        findById: (id: string) => {
          lastId = id;
          return Effect.succeed(null);
        },
      }),
    });

    const result = await runHandler(handler, { threadId: "0000notfound0000" });
    expect(result.success).toBe(false);
    const failure1 = assertFailure(result);
    expect(failure1.code).toBe("ARTIFACT_NOT_FOUND");
    expect(lastId).toBe("0000notfound0000");
  });

  it("returns ARTIFACT_CORRUPTED when the store throws", async () => {
    const handler = buildHandler({
      createThreadStore: async () => makeFindByIdThrows(),
    });

    const result = await runHandler(handler, { threadId: VALID_THREAD_ID });
    expect(result.success).toBe(false);
    const failure = assertFailure(result);
    expect(failure.code).toBe("ARTIFACT_CORRUPTED");
    expect(failure.message).toBe("该学习线程数据损坏，无法加载。");
  });

  it("returns INVALID_REQUEST for an empty threadId", async () => {
    const handler = buildHandler();
    const result = await runHandler(handler, { threadId: "" });
    expect(result.success).toBe(false);
    const failure = assertFailure(result);
    expect(failure.code).toBe("INVALID_REQUEST");
    expect(failure.message).toBe("请输入有效的线程 ID。");
  });

  it("returns INVALID_REQUEST for a whitespace-only threadId", async () => {
    const handler = buildHandler();
    const result = await runHandler(handler, { threadId: "   " });
    expect(result.success).toBe(false);
    const failure = assertFailure(result);
    expect(failure.code).toBe("INVALID_REQUEST");
  });

  it("trims the threadId before passing it to the store", async () => {
    let receivedId: string | undefined;
    const handler = buildHandler({
      createThreadStore: async () => ({
        save: () => Effect.void,
        findById: (id: string) => {
          receivedId = id;
          return Effect.succeed(null);
        },
      }),
    });

    await runHandler(handler, { threadId: `  ${VALID_THREAD_ID}  ` });
    expect(receivedId).toBe(VALID_THREAD_ID);
  });

  it("returns INVALID_REQUEST when threadId is not provided", async () => {
    const result = await runHandler(buildHandler(), { threadId: "" });
    expect(result.success).toBe(false);
    const failure = assertFailure(result);
    expect(failure.code).toBe("INVALID_REQUEST");
  });

  it("does not call the store when the threadId is empty", async () => {
    let storeCreated = false;
    const handler = buildHandler({
      createThreadStore: async () => {
        storeCreated = true;
        return makeStore(makeArtifact());
      },
    });

    await runHandler(handler, { threadId: "" });
    expect(storeCreated).toBe(false);
  });

  it("does not call the store when threadId is whitespace only", async () => {
    let storeCreated = false;
    const handler = buildHandler({
      createThreadStore: async () => {
        storeCreated = true;
        return makeStore(makeArtifact());
      },
    });

    await runHandler(handler, { threadId: "  " });
    expect(storeCreated).toBe(false);
  });

  it("creates the store lazily (only when needed)", async () => {
    let created = false;
    const handler = buildHandler({
      createThreadStore: async () => {
        created = true;
        return makeStore(makeArtifact());
      },
    });

    // First call with valid ID triggers creation
    await runHandler(handler, { threadId: VALID_THREAD_ID });
    expect(created).toBe(true);
  });

  it("calls findById with the trimmed threadId", async () => {
    let capturedThreadId: string | undefined;
    const handler = buildHandler({
      createThreadStore: async () => ({
        save: () => Effect.void,
        findById: (id: string) => {
          capturedThreadId = id;
          return Effect.succeed(makeArtifact());
        },
      }),
    });

    await runHandler(handler, { threadId: ` ${VALID_THREAD_ID} ` });
    expect(capturedThreadId).toBe(VALID_THREAD_ID);
  });

  it("returns the full artifact on a successful lookup", async () => {
    const art = makeArtifact({
      question: "Full question text",
      learningNodes: [],
      timelineStages: [],
      fingerprint: "v1:fullfingerprint",
    });
    const handler = buildHandler({
      createThreadStore: async () => makeStore(art),
    });

    const result = await runHandler(handler, { threadId: VALID_THREAD_ID });
    expect(result.success).toBe(true);
    expect((result as { success: true; artifact: QuestionLearningThread }).artifact.question).toBe(
      "Full question text",
    );
    expect(
      (result as { success: true; artifact: QuestionLearningThread }).artifact.fingerprint,
    ).toBe("v1:fullfingerprint");
  });
});
