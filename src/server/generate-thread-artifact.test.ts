import { describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";

import {
  createGenerateThreadHandler,
  parseGenerateThreadInput,
  type GenerateThreadDeps,
} from "./generate-thread-artifact";
import type { AnswerExcerpt } from "../lib/answer-excerpt";
import type { ThreadArtifactStore } from "../lib/thread-artifact-store";
import type { ExcerptStore } from "../lib/excerpt-store";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn(() => ({
    validator: vi.fn().mockReturnThis(),
    handler: vi.fn().mockReturnThis(),
  })),
}));

const EXCERPT_TEXT =
  "React Server Components 只在服务端运行。它们把不需要交互的内容留在服务端，跨端时要经过序列化边界。";

const storedExcerpt: AnswerExcerpt = {
  questionId: "42",
  answerId: "100",
  capturedAt: 1_700_000_000_000,
  sourceContentId: "src-1",
  sourceContentType: "Answer",
  sourceEditTime: 1_700_000_000,
  excerpt: EXCERPT_TEXT,
  fingerprint: "v1:5555555555555555",
};

const makeDeps = (
  chatResponse: string,
  secret = "test-model-key",
): { deps: GenerateThreadDeps; saved: unknown[] } => {
  const saved: unknown[] = [];
  const excerptStore: ExcerptStore = {
    save: () => Effect.succeed(undefined),
    findLatest: () => Effect.succeed(storedExcerpt),
  };
  const threadStore = {
    save: (artifact: unknown) => {
      saved.push(artifact);
      return Effect.succeed(undefined);
    },
    load: () => Effect.succeed(null),
  } as unknown as ThreadArtifactStore;

  return {
    saved,
    deps: {
      getSecret: vi.fn(() => secret),
      getModel: vi.fn(() => "test-model"),
      createExcerptStore: vi.fn(async () => excerptStore),
      createThreadStore: vi.fn(async () => threadStore),
      createChat: vi.fn(
        async () =>
          ({
            complete: () => Effect.succeed(chatResponse),
          }) as unknown as Awaited<ReturnType<GenerateThreadDeps["createChat"]>>,
      ),
    },
  };
};

const baseInput = {
  question: "如何理解 React Server Components？",
  refinedQuery: "React Server Components 服务端组件 序列化边界",
  learningIntent: "理解核心概念与适用边界。",
  confidence: 0.9,
  selectedCandidates: [
    {
      questionId: "42",
      answerId: "100",
      title: "如何看待 React Server Components?",
      authorDisplayName: "作者甲",
      editTime: 1_700_000_000,
      canonicalUrl: "https://www.zhihu.com/question/42/answer/100",
      excerptFingerprint: "v1:5555555555555555",
    },
  ],
};

const modelNode = (quote: string) =>
  JSON.stringify({
    nodes: [
      {
        kind: "evolution",
        title: "跨端边界",
        summary: "摘录把序列化边界当作服务端组件与客户端之间的分界条件。",
        evidenceRefs: [{ excerptFingerprint: "v1:5555555555555555", quote }],
        sourceAnswerId: "100",
        sourceUrl: "https://www.zhihu.com/question/42/answer/100",
        uncertainty: 0.3,
      },
    ],
  });

describe("generate-thread-artifact synthesis mode", () => {
  it("reports synthesized when the model's own nodes survive validation", async () => {
    const { deps } = makeDeps(
      modelNode("它们把不需要交互的内容留在服务端，跨端时要经过序列化边界。"),
    );
    const result = await createGenerateThreadHandler(deps)(baseInput);
    expect(result.success).toBe(true);
    if (result.success) expect(result.mode).toBe("synthesized");
  });

  it("reports evidence_only when every model citation is invented", async () => {
    const { deps } = makeDeps(modelNode("这句话在摘录里完全不存在。"));
    const result = await createGenerateThreadHandler(deps)(baseInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mode).toBe("evidence_only");
      expect(result.threadId).toBeTruthy();
    }
  });

  it("reports evidence_only without a model key", async () => {
    const { deps } = makeDeps(modelNode("unused"), "");
    const result = await createGenerateThreadHandler(deps)(baseInput);
    expect(result.success).toBe(true);
    if (result.success) expect(result.mode).toBe("evidence_only");
  });
});

// ── Input validation ────────────────────────────────────────────────────────

describe("parseGenerateThreadInput", () => {
  const candidate = (overrides: Record<string, unknown>) => ({
    questionId: "42",
    answerId: "100",
    title: "Title",
    authorDisplayName: "Author",
    editTime: 1_700_000_000,
    canonicalUrl: "https://www.zhihu.com/question/42/answer/100",
    excerptFingerprint: "v1:5555555555555555",
    ...overrides,
  });

  const parse = (candidates: readonly unknown[]) =>
    parseGenerateThreadInput({
      question: "q",
      refinedQuery: "r",
      learningIntent: "i",
      confidence: 0.5,
      selectedCandidates: candidates,
    });

  it("keeps a column article even though it has no question id", () => {
    const parsed = parse([
      candidate({
        questionId: "",
        answerId: "617256830",
        canonicalUrl: "https://zhuanlan.zhihu.com/p/617256830",
      }),
    ]);

    expect(parsed.selectedCandidates).toHaveLength(1);
    expect(parsed.selectedCandidates[0]?.answerId).toBe("617256830");
    expect(parsed.selectedCandidates[0]?.questionId).toBe("");
  });

  it("keeps a mix of articles and answers", () => {
    const parsed = parse([
      candidate({
        questionId: "",
        answerId: "617256830",
        canonicalUrl: "https://zhuanlan.zhihu.com/p/617256830",
      }),
      candidate({}),
    ]);

    expect(parsed.selectedCandidates).toHaveLength(2);
  });

  it("drops an answer that lost its question id", () => {
    expect(parse([candidate({ questionId: "" })]).selectedCandidates).toEqual([]);
  });

  it("drops candidates with a missing id or a non-Zhihu URL", () => {
    expect(parse([candidate({ answerId: "" })]).selectedCandidates).toEqual([]);
    expect(
      parse([candidate({ canonicalUrl: "https://example.com/question/42/answer/100" })])
        .selectedCandidates,
    ).toEqual([]);
  });
});
