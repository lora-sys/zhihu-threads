import { Effect } from "effect";

import { describe, expect, it } from "vite-plus/test";

import { OpenAiTransportError } from "./openai-adapter";
import type { TimelineStage, LearningGuideInput } from "./thread-artifact";

import {
  synthesizeThread,
  ThreadSynthesisError,
  type ThreadSynthesisDeps,
  type SynthesisInput,
  type ThreadSynthesisResult,
  type SynthesizedNode,
} from "./thread-synthesis";

// ── Helpers ──────────────────────────────────────────────────────────────

const makeStage = (overrides: Partial<TimelineStage> = {}): TimelineStage => ({
  questionId: "42",
  answerId: "100",
  title: "Stage title",
  authorDisplayName: "Author",
  editTime: 1_700_000_000_000,
  canonicalUrl: "https://www.zhihu.com/question/42/answer/100",
  excerpt: {
    questionId: "42",
    answerId: "100",
    capturedAt: 1_700_000_000_000,
    sourceContentId: "src-1",
    sourceContentType: "Answer",
    sourceEditTime: 1_700_000_000_000,
    excerpt: "This is the exact excerpt text that must appear in the quote.",
    fingerprint: "v1:5555555555555555",
  },
  excerptBoundaryNote: "这是摘录，不是完整回答",
  ...overrides,
});

const BASE_STAGES = [makeStage()];

const makeInput = (overrides: Partial<SynthesisInput> = {}): SynthesisInput => ({
  question: "How do modern web frameworks handle state?",
  refinedQuery: "zhihu web framework state management",
  learningIntent: "Understand the evolution of state management patterns",
  timelineStages: BASE_STAGES,
  maxNodes: 7,
  ...overrides,
});

const validNodePayload: SynthesizedNode = {
  kind: "relationship",
  title: "A valid learning node title",
  summary: "This is a valid summary of a learning relationship.",
  evidenceRefs: [
    {
      excerptFingerprint: "v1:5555555555555555",
      quote: "This is the exact excerpt text that must appear in the quote.",
    },
  ],
  sourceAnswerId: "100",
  sourceUrl: "https://www.zhihu.com/question/42/answer/100",
  uncertainty: 0.5,
};

const buildValidResponse = (nodes?: SynthesizedNode[]): string =>
  JSON.stringify({
    nodes: nodes ?? [validNodePayload],
    guide: validGuidePayload,
  });

const validGuidePayload: LearningGuideInput = {
  overview: {
    headline: "How the answer adds to the thread",
    summary: "The selected excerpt anchors the learning question.",
    evidenceRefs: [
      {
        excerptFingerprint: "v1:5555555555555555",
        quote: "This is the exact excerpt text that must appear in the quote.",
      },
    ],
  },
  stages: [
    {
      answerId: "100",
      role: "baseline",
      explanation: "This answer provides the baseline premise for the thread.",
      evidenceRefs: [
        {
          excerptFingerprint: "v1:5555555555555555",
          quote: "This is the exact excerpt text that must appear in the quote.",
        },
      ],
    },
  ],
  openQuestions: ["What changed after this answer was written?"],
};

const baseDeps = (chat: ThreadSynthesisDeps["chat"]): ThreadSynthesisDeps => ({
  model: "zhida-thinking-1p5",
  chat,
});

const makeSucceedChat = (response: string): ThreadSynthesisDeps["chat"] => ({
  complete: () => Effect.succeed(response),
});

const makeFailingChat = (_err: ThreadSynthesisError): ThreadSynthesisDeps["chat"] => ({
  complete: () => Effect.fail(_err) as unknown as Effect.Effect<string, never>,
});

const runWorkflow = async (
  deps: ThreadSynthesisDeps,
  input: SynthesisInput,
): Promise<
  | { _tag: "success"; result: ThreadSynthesisResult }
  | { _tag: "error"; error: ThreadSynthesisError }
> => {
  const exit = await Effect.runPromiseExit(synthesizeThread(deps)(input));
  if (exit._tag === "Success") {
    return { _tag: "success", result: exit.value };
  }
  const error =
    exit.cause._tag === "Fail"
      ? exit.cause.error
      : new ThreadSynthesisError({ reason: "MALFORMED_RESPONSE" });
  return { _tag: "error", error };
};

// ── synthesizeThread workflow ────────────────────────────────────────────

describe("thread-synthesis synthesizeThread", () => {
  it("returns valid nodes when the model returns well-formed JSON", async () => {
    const chat = makeSucceedChat(buildValidResponse([{ ...validNodePayload, kind: "evolution" }]));

    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.nodes).toHaveLength(1);
      expect(result.learningGuide.stages[0].answerId).toBe("100");
      expect(result.learningGuide.stages[0].role).toBe("baseline");
      expect(result.nodes[0].kind).toBe("evolution");
      expect(result.nodes[0].title).toBe(validNodePayload.title);
      expect(result.nodes[0].sourceAnswerId).toBe("100");
      expect(result.nodes[0].uncertainty).toBe(0.5);
    }
  });

  it("repairs a node whose declared source is not among its own citations", async () => {
    const firstStage = makeStage();
    const secondStage = makeStage({
      answerId: "200",
      canonicalUrl: "https://www.zhihu.com/question/42/answer/200",
      excerpt: {
        ...firstStage.excerpt,
        answerId: "200",
        sourceContentId: "src-2",
        excerpt: "A second answer explains a different part of the mechanism.",
        fingerprint: "v1:6666666666666666",
      },
    });

    // Known answer id, but this node never quotes that answer.
    const misattributed: SynthesizedNode = {
      ...validNodePayload,
      sourceAnswerId: "200",
      sourceUrl: "https://www.zhihu.com/question/42/answer/200",
    };

    const outcome = await runWorkflow(
      baseDeps(makeSucceedChat(buildValidResponse([misattributed]))),
      makeInput({ timelineStages: [firstStage, secondStage] }),
    );

    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      expect(outcome.result.nodes).toHaveLength(1);
      expect(outcome.result.nodes[0]?.sourceAnswerId).toBe("100");
      expect(outcome.result.nodes[0]?.sourceUrl).toBe(
        "https://www.zhihu.com/question/42/answer/100",
      );
    }
  });

  it("uses a safe fallback guide when the model guide has a bad citation", async () => {
    const response = JSON.stringify({
      nodes: [validNodePayload],
      guide: {
        ...validGuidePayload,
        overview: {
          ...validGuidePayload.overview,
          evidenceRefs: [
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "This quote is not in the selected excerpt.",
            },
          ],
        },
      },
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      expect(outcome.result.learningGuide.overview.headline).toBe("从真实摘录组织的学习线");
      expect(outcome.result.learningGuide.stages[0].role).toBe("baseline");
      expect(
        outcome.result.learningGuide.overview.evidenceRefs.every((ref) =>
          BASE_STAGES.some(
            (stage) =>
              stage.excerpt.fingerprint === ref.excerptFingerprint &&
              stage.excerpt.excerpt.includes(ref.quote),
          ),
        ),
      ).toBe(true);
    }
  });

  it("accepts the 'unknown' kind from the model output", async () => {
    const response = JSON.stringify({
      nodes: [
        {
          kind: "unknown",
          title: "Unclear premise",
          summary: "The relationship is not certain.",
          evidenceRefs: [
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "This is the exact excerpt text that must appear in the quote.",
            },
          ],
          sourceAnswerId: "100",
          sourceUrl: "https://www.zhihu.com/question/42/answer/100",
          uncertainty: 0.9,
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      expect(outcome.result.nodes[0].kind).toBe("unknown");
    }
  });

  it("returns MALFORMED_RESPONSE error for non-JSON model output", async () => {
    const chat = makeSucceedChat("not valid json at all");
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("error");
    if (outcome._tag === "error") {
      expect(outcome.error.reason).toBe("MALFORMED_RESPONSE");
    }
  });

  it("returns MALFORMED_RESPONSE error for a JSON array response", async () => {
    const chat = makeSucceedChat(JSON.stringify([1, 2, 3]));
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("error");
    if (outcome._tag === "error") {
      expect(outcome.error.reason).toBe("MALFORMED_RESPONSE");
    }
  });

  it("returns MALFORMED_RESPONSE error for JSON root that is not an object", async () => {
    const chat = makeSucceedChat(JSON.stringify({ notNodes: true }));
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("error");
    if (outcome._tag === "error") {
      expect(outcome.error.reason).toBe("MALFORMED_RESPONSE");
    }
  });

  it("returns MALFORMED_RESPONSE error for an empty nodes array", async () => {
    const chat = makeSucceedChat(JSON.stringify({ nodes: [] }));
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("error");
    if (outcome._tag === "error") {
      expect(outcome.error.reason).toBe("MALFORMED_RESPONSE");
    }
  });

  it("returns TRANSPORT_FAILED when the chat service throws", async () => {
    const chat = makeFailingChat(new ThreadSynthesisError({ reason: "TRANSPORT_FAILED" }));
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("error");
    if (outcome._tag === "error") {
      expect(outcome.error.reason).toBe("TRANSPORT_FAILED");
    }
  });

  it("recovers when the first payload rejects every node and the second is valid", async () => {
    // Observed live: identical excerpts produced valid nodes on one call and a
    // contract-violating payload on the next.  Without a bounded retry that
    // hiccup collapses the whole thread into an evidence-only dump.
    let calls = 0;
    const chat: ThreadSynthesisDeps["chat"] = {
      complete: () => {
        calls += 1;
        return calls === 1
          ? Effect.succeed(JSON.stringify({ nodes: [{ kind: "nonsense" }] }))
          : Effect.succeed(buildValidResponse([{ ...validNodePayload }]));
      },
    };

    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("success");
    expect(calls).toBe(2);
    if (outcome._tag === "success") expect(outcome.result.source).toBe("model");
  });

  it("does not re-retry a transport failure, which the adapter already retried", async () => {
    let calls = 0;
    const chat: ThreadSynthesisDeps["chat"] = {
      complete: () => {
        calls += 1;
        return Effect.fail(
          new OpenAiTransportError({ reason: "NETWORK_FAILED" }),
        ) as unknown as Effect.Effect<string, never>;
      },
    };

    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("error");
    if (outcome._tag === "error") expect(outcome.error.reason).toBe("TRANSPORT_FAILED");
    expect(calls).toBe(1);
  });

  it("returns fallback nodes when all model nodes have banned wording in summary", async () => {
    const response = JSON.stringify({
      nodes: [
        {
          kind: "relationship",
          title: "Valid Title",
          summary: "The original author was wrong about this premise.",
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.nodes.every((n: SynthesizedNode) => n.kind === "unknown")).toBe(true);
    }
  });

  it("returns fallback nodes when all model nodes have banned Chinese wording in title", async () => {
    const response = JSON.stringify({
      nodes: [
        {
          kind: "relationship",
          title: "作者写了错误观点",
          summary: "A valid summary.",
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.nodes.every((n: SynthesizedNode) => n.kind === "unknown")).toBe(true);
    }
  });

  it("recovers the source answer from the citation when the model's id is wrong", async () => {
    // The quote has already been verified against one specific excerpt, so the
    // answer it came from is known to us.  Discarding a grounded node over a
    // bookkeeping field the model got wrong loses real learning value.
    const response = JSON.stringify({
      nodes: [
        {
          kind: "relationship",
          title: "Valid",
          summary: "A valid summary.",
          evidenceRefs: [
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "This is the exact excerpt text that must appear in the quote.",
            },
          ],
          sourceAnswerId: "unknown-id",
          sourceUrl: "https://www.zhihu.com/question/42/answer/unknown",
          uncertainty: 0.5,
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.source).toBe("model");
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].kind).toBe("relationship");
      expect(result.nodes[0].sourceAnswerId).toBe("100");
      expect(result.nodes[0].sourceUrl).toBe("https://www.zhihu.com/question/42/answer/100");
    }
  });

  it("still falls back when no citation resolves to a known excerpt", async () => {
    const response = JSON.stringify({
      nodes: [
        {
          kind: "relationship",
          title: "Valid",
          summary: "A valid summary.",
          evidenceRefs: [
            {
              excerptFingerprint: "v1:does-not-exist",
              quote: "This quote came from nowhere.",
            },
          ],
          sourceAnswerId: "unknown-id",
          uncertainty: 0.5,
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.source).toBe("fallback");
      expect(result.nodes.every((n: SynthesizedNode) => n.kind === "unknown")).toBe(true);
    }
  });

  it("filters invalid nodes but keeps valid ones in the same response", async () => {
    const response = JSON.stringify({
      nodes: [
        { kind: "totally_invalid" as string, title: "Bad", summary: "Bad." },
        validNodePayload,
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].kind).toBe("relationship");
    }
  });

  it("builds the user prompt with question, refined query, and learning intent", async () => {
    let capturedRequest: {
      model: string;
      messages: { role: string; content: string }[];
    } | null = null;

    const chat: ThreadSynthesisDeps["chat"] = {
      complete: (request) => {
        capturedRequest = {
          model: request.model,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        };
        return Effect.succeed(buildValidResponse());
      },
    };

    await runWorkflow(baseDeps(chat), makeInput());

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.model).toBe("zhida-thinking-1p5");
    expect(capturedRequest!.messages[0].role).toBe("system");
    const userPrompt = capturedRequest!.messages[1].content;
    expect(userPrompt).toContain("How do modern web frameworks handle state?");
    expect(userPrompt).toContain("zhihu web framework state management");
    expect(userPrompt).toContain("Understand the evolution of state management patterns");
    expect(userPrompt).toContain("[Answer 100]");
    expect(userPrompt).toContain("v1:5555555555555555");
  });

  it("includes maxNodes in the user prompt", async () => {
    let capturedUserPrompt: string | null = null;

    const chat: ThreadSynthesisDeps["chat"] = {
      complete: (request) => {
        capturedUserPrompt = request.messages[1].content;
        return Effect.succeed(buildValidResponse());
      },
    };

    await runWorkflow(baseDeps(chat), makeInput({ maxNodes: 3 }));
    expect(capturedUserPrompt).toContain("up to 3");
  });

  it("returns MALFORMED_RESPONSE for a question exceeding 500 characters", async () => {
    const input = makeInput({ question: "x".repeat(501) });
    const chat = makeSucceedChat(buildValidResponse());
    const outcome = await runWorkflow(baseDeps(chat), input);
    expect(outcome._tag).toBe("error");
    if (outcome._tag === "error") {
      expect(outcome.error.reason).toBe("MALFORMED_RESPONSE");
    }
  });

  it("caps fallback output at maxNodes when all nodes are rejected", async () => {
    const twoStages = [makeStage({ answerId: "1" }), makeStage({ answerId: "2" })];
    const response = JSON.stringify({
      nodes: [
        {
          kind: "relationship",
          title: "Bad",
          summary: "The 原作者 was 错了 about this.",
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(
      baseDeps(chat),
      makeInput({ timelineStages: twoStages, maxNodes: 1 }),
    );
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].kind).toBe("unknown");
      expect(result.nodes[0].sourceAnswerId).toBe("1");
    }
  });

  it("falls back to unknown nodes when evidence quotes do not match excerpt text", async () => {
    const response = JSON.stringify({
      nodes: [
        {
          kind: "relationship",
          title: "Valid",
          summary: "A valid summary.",
          evidenceRefs: [
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "This quote text does not match the excerpt content at all.",
            },
          ],
          sourceAnswerId: "100",
          sourceUrl: "https://www.zhihu.com/question/42/answer/100",
          uncertainty: 0.5,
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.nodes.every((n: SynthesizedNode) => n.kind === "unknown")).toBe(true);
    }
  });

  it("replaces a model-echoed URL with our canonical URL instead of rejecting", async () => {
    // The provider hands back URLs carrying utm tracking params, and the model
    // often cleans them.  We already own the canonical URL, so a mismatch is a
    // formatting difference, not an evidence problem.
    const response = JSON.stringify({
      nodes: [
        {
          kind: "relationship",
          title: "Valid",
          summary: "A valid summary.",
          evidenceRefs: [
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "This is the exact excerpt text that must appear in the quote.",
            },
          ],
          sourceAnswerId: "100",
          sourceUrl: "https://www.zhihu.com/question/999/answer/100",
          uncertainty: 0.5,
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(baseDeps(chat), makeInput());
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      const { result } = outcome;
      expect(result.source).toBe("model");
      expect(result.nodes[0].kind).toBe("relationship");
      expect(result.nodes[0].sourceUrl).toBe("https://www.zhihu.com/question/42/answer/100");
    }
  });

  it("reports why every model node was rejected", async () => {
    const rejected: string[] = [];
    const response = JSON.stringify({
      nodes: [
        {
          kind: "not_a_real_kind",
          title: "Valid",
          summary: "A valid summary.",
          evidenceRefs: [
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "This is the exact excerpt text that must appear in the quote.",
            },
          ],
          sourceAnswerId: "100",
          uncertainty: 0.5,
        },
      ],
    });
    const chat = makeSucceedChat(response);
    const outcome = await runWorkflow(
      { model: "zhida-thinking-1p5", chat, onDiagnostics: (d) => rejected.push(...d.rejected) },
      makeInput(),
    );
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") expect(outcome.result.source).toBe("fallback");
    // One reason per attempt, proving the retry budget was actually spent.
    expect(rejected).toEqual(["bad_kind", "bad_kind"]);
  });

  it("snaps a whitespace-drifted quote back to verbatim source text", async () => {
    const stage = makeStage({
      excerpt: {
        ...makeStage().excerpt,
        excerpt: "第一行说明\n\n第二行给出机制：序列化边界决定了数据何时跨越服务端与客户端。",
      },
    });
    const response = JSON.stringify({
      nodes: [
        {
          kind: "evolution",
          title: "跨端边界",
          summary: "摘录把序列化边界当作服务端与客户端之间的分界条件。",
          evidenceRefs: [
            {
              excerptFingerprint: stage.excerpt.fingerprint,
              // Same words, collapsed newline — models do this constantly.
              quote: "第二行给出机制：序列化边界决定了数据何时跨越服务端与客户端。",
            },
          ],
          sourceAnswerId: stage.answerId,
          sourceUrl: stage.canonicalUrl,
          uncertainty: 0.3,
        },
      ],
    });
    const outcome = await runWorkflow(
      baseDeps(makeSucceedChat(response)),
      makeInput({
        timelineStages: [stage],
      }),
    );
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      const node = outcome.result.nodes[0];
      expect(node.kind).toBe("evolution");
      expect(node.evidenceRefs[0].quote).toBe(
        "第二行给出机制：序列化边界决定了数据何时跨越服务端与客户端。",
      );
      // The shipped quote must still be a byte-exact substring of the source.
      expect(stage.excerpt.excerpt.includes(node.evidenceRefs[0].quote)).toBe(true);
    }
  });

  it("keeps a node when one citation is invented but another is real", async () => {
    const response = JSON.stringify({
      nodes: [
        {
          kind: "cause",
          title: "部分可引用的节点",
          summary: "一条引用是编造的，另一条来自摘录，节点应当保留。",
          evidenceRefs: [
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "这句话在摘录里根本不存在，属于模型编造。",
            },
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "exact excerpt text",
            },
          ],
          sourceAnswerId: "100",
          sourceUrl: "https://www.zhihu.com/question/42/answer/100",
          uncertainty: 0.4,
        },
      ],
    });
    const outcome = await runWorkflow(baseDeps(makeSucceedChat(response)), makeInput());
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      expect(outcome.result.source).toBe("model");
      expect(outcome.result.nodes).toHaveLength(1);
      expect(outcome.result.nodes[0].kind).toBe("cause");
      expect(outcome.result.nodes[0].evidenceRefs).toHaveLength(1);
      expect(outcome.result.nodes[0].evidenceRefs[0].quote).toBe("exact excerpt text");
    }
  });

  it("reports fallback source when every citation is invented", async () => {
    const response = JSON.stringify({
      nodes: [
        {
          kind: "consensus",
          title: "无证据节点",
          summary: "所有引用都不在摘录里。",
          evidenceRefs: [
            {
              excerptFingerprint: "v1:5555555555555555",
              quote: "完全不存在的句子",
            },
          ],
          sourceAnswerId: "100",
          sourceUrl: "https://www.zhihu.com/question/42/answer/100",
          uncertainty: 0.2,
        },
      ],
    });
    const outcome = await runWorkflow(baseDeps(makeSucceedChat(response)), makeInput());
    expect(outcome._tag).toBe("success");
    if (outcome._tag === "success") {
      expect(outcome.result.source).toBe("fallback");
      expect(outcome.result.nodes[0].kind).toBe("unknown");
    }
  });

  it("sends the model more than a headline fragment of each excerpt", async () => {
    const longBody = `序列化边界 ${"机制说明".repeat(200)}`;
    const stage = makeStage({
      excerpt: { ...makeStage().excerpt, excerpt: longBody },
    });
    const prompts: string[] = [];
    const chat: ThreadSynthesisDeps["chat"] = {
      complete: ({ messages }) => {
        prompts.push(messages[messages.length - 1].content);
        return Effect.succeed(
          JSON.stringify({
            nodes: [
              {
                kind: "evolution",
                title: "长摘录节点",
                summary: "摘录中段的机制被完整提供给模型。",
                evidenceRefs: [
                  {
                    excerptFingerprint: stage.excerpt.fingerprint,
                    quote: "机制说明".repeat(3),
                  },
                ],
                sourceAnswerId: stage.answerId,
                sourceUrl: stage.canonicalUrl,
                uncertainty: 0.3,
              },
            ],
          }),
        );
      },
    };
    await runWorkflow(baseDeps(chat), makeInput({ timelineStages: [stage] }));
    expect(prompts).toHaveLength(1);
    // The old budget cut every excerpt at 300 characters; the learning nodes
    // need the body, not just the opening line.
    expect(prompts[0].split("机制说明").length - 1).toBeGreaterThan(100);
  });
});
