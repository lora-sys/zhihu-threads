import { describe, expect, it } from "vite-plus/test";

import type {
  ThreadArtifactFailure,
  ThreadArtifactFailureReason,
  ThreadArtifactInput,
  ThreadArtifactResult,
  ThreadArtifactSuccess,
  TimelineStageInput,
} from "./thread-artifact";
import type { LearningNodeInput } from "./thread-artifact";
import {
  createQuestionLearningThread,
  extractZhihuAnswerId,
  extractZhihuQuestionId,
  sortLearningNodes,
} from "./thread-artifact";

// ── Helpers ──────────────────────────────────────────────────────────────

const makeStage = (overrides: Partial<TimelineStageInput> = {}): TimelineStageInput => ({
  questionId: "123",
  answerId: "456",
  title: "Test Answer",
  authorDisplayName: "Tester",
  editTime: 1_700_000_000_000,
  canonicalUrl: "https://www.zhihu.com/question/123/answer/456",
  excerpt: {
    questionId: "123",
    answerId: "456",
    capturedAt: 1_700_000_000_000,
    sourceContentId: "src-1",
    sourceContentType: "Answer",
    sourceEditTime: 1_700_000_000_000,
    excerpt: "This is a excerpt text from the answer.",
    fingerprint: "v1:aaaaaaaaaaaaaaaa",
  },
  ...overrides,
});

const makeNode = (overrides: Partial<LearningNodeInput> = {}): LearningNodeInput => ({
  kind: "relationship",
  title: "A connection",
  summary: "These things are related.",
  evidenceRefs: [
    {
      excerptFingerprint: "v1:aaaaaaaaaaaaaaaa",
      quote: "This is a excerpt text from the answer.",
    },
  ],
  sourceAnswerId: "456",
  sourceUrl: "https://www.zhihu.com/question/123/answer/456",
  uncertainty: 0.5,
  ...overrides,
});

const makeInput = (overrides: Partial<ThreadArtifactInput> = {}): ThreadArtifactInput => ({
  threadId: "a1b2c3d4e5f6a7b8",
  question: "How do things relate?",
  refinedQuery: "zhihu how things relate",
  createdAt: 1_700_000_000_000,
  timelineStages: [makeStage()],
  learningNodes: [makeNode()],
  uncertainty: 0.3,
  ...overrides,
});

const isSuccess = (result: ThreadArtifactResult): result is ThreadArtifactSuccess =>
  result._tag === "success";

const isFailure = (result: ThreadArtifactResult): result is ThreadArtifactFailure =>
  result._tag === "failure";

const asSuccess = (result: ThreadArtifactResult): ThreadArtifactSuccess => {
  expect(isSuccess(result)).toBe(true);
  return result as ThreadArtifactSuccess;
};

const asFailure = (result: ThreadArtifactResult): ThreadArtifactFailure => {
  expect(isFailure(result)).toBe(true);
  return result as ThreadArtifactFailure;
};

// ── Valid input ───────────────────────────────────────────────────────────

describe("thread-artifact", () => {
  describe("createQuestionLearningThread", () => {
    it("returns success with all fields populated for valid input", () => {
      const input = makeInput();
      const result = createQuestionLearningThread(input);

      const artifact = asSuccess(result).artifact;
      expect(artifact.threadId).toBe("a1b2c3d4e5f6a7b8");
      expect(artifact.question).toBe("How do things relate?");
      expect(artifact.refinedQuery).toBe("zhihu how things relate");
      expect(artifact.createdAt).toBe(1_700_000_000_000);
      expect(artifact.uncertainty).toBe(0.3);
      expect(artifact.fingerprint).toMatch(/^v1:[0-9a-f]{16}$/);
      expect(artifact.timelineStages).toHaveLength(1);
      expect(artifact.learningNodes).toHaveLength(1);
    });

    it("assembles the timelineStage with normalized fields and boundary note", () => {
      const stage = makeStage({ title: "  Titled  ", authorDisplayName: "  Author Name  " });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));

      const ts = asSuccess(result).artifact.timelineStages[0];
      expect(ts.questionId).toBe("123");
      expect(ts.answerId).toBe("456");
      expect(ts.title).toBe("Titled");
      expect(ts.authorDisplayName).toBe("Author Name");
      expect(ts.excerptBoundaryNote).toBe("这是摘录，不是完整回答");
    });

    it("freeszes the output artifact", () => {
      const result = createQuestionLearningThread(makeInput());
      expect(Object.isFrozen(asSuccess(result).artifact)).toBe(true);
    });

    it("normalizes whitespace in question, refinedQuery, and summary fields", () => {
      const input = makeInput({
        question: "   spaced question   ",
        refinedQuery: "\r\nlineended\r\n",
        learningNodes: [makeNode({ summary: "  line\nended  " })],
      });
      const result = createQuestionLearningThread(input);

      expect(asSuccess(result).artifact.question).toBe("spaced question");
      expect(asSuccess(result).artifact.refinedQuery).toBe("lineended");
      expect(asSuccess(result).artifact.learningNodes[0].summary).toBe("line\nended");
    });

    it("normalizes Unicode combining characters to NFC", () => {
      // U+0301 is combining acute accent: "e" + U+0301 composes to "é"
      const nfdInput = "caf" + String.fromCharCode(0x0065, 0x0301) + " text?";
      // Build the expected by normalizing (deterministic, avoids literal encoding issues)
      const expected = nfdInput.normalize("NFC").trim();

      const result = createQuestionLearningThread(makeInput({ question: nfdInput }));

      expect(asSuccess(result).artifact.question).toBe(expected);
      expect(asSuccess(result).artifact.question).toContain(String.fromCharCode(0x00e9));
    });
  });

  // ── Validation: threadId ────────────────────────────────────────────────

  describe("threadId validation", () => {
    it.each([
      {
        label: "empty string",
        value: "",
        reason: "INVALID_THREAD_ID" as ThreadArtifactFailureReason,
      },
      { label: "UpperCase hex", value: "A1B2C3D4E5F6A7B8", reason: "INVALID_THREAD_ID" },
      { label: "too short (15 chars)", value: "a1b2c3d4e5f6a7", reason: "INVALID_THREAD_ID" },
      { label: "too long (17 chars)", value: "a1b2c3d4e5f6a7b89", reason: "INVALID_THREAD_ID" },
      { label: "non-hex chars", value: "g1b2c3d4e5f6a7b8", reason: "INVALID_THREAD_ID" },
      { label: "null", value: null as unknown as string, reason: "INVALID_THREAD_ID" },
      { label: "number", value: 42 as unknown as string, reason: "INVALID_THREAD_ID" },
    ])("returns $reason for $label threadId", ({ value, reason }) => {
      const result = createQuestionLearningThread(makeInput({ threadId: value }));
      expect(asFailure(result).reason).toBe(reason);
    });

    it("accepts a lowercase 16-char hex threadId", () => {
      const result = createQuestionLearningThread(makeInput({ threadId: "0000000000000000" }));
      expect(isSuccess(result)).toBe(true);
    });
  });

  // ── Validation: question ────────────────────────────────────────────────

  describe("question validation", () => {
    it("returns EMPTY_QUESTION for an empty string", () => {
      const result = createQuestionLearningThread(makeInput({ question: "" }));
      expect(asFailure(result).reason).toBe("EMPTY_QUESTION");
    });

    it("returns EMPTY_QUESTION for a string of only whitespace", () => {
      const result = createQuestionLearningThread(makeInput({ question: "   " }));
      expect(asFailure(result).reason).toBe("EMPTY_QUESTION");
    });

    it("returns EMPTY_QUESTION for a non-string question", () => {
      const result = createQuestionLearningThread(
        makeInput({ question: null as unknown as string }),
      );
      expect(asFailure(result).reason).toBe("EMPTY_QUESTION");
    });
  });

  // ── Validation: refinedQuery ────────────────────────────────────────────

  describe("refinedQuery validation", () => {
    it("returns EMPTY_REFINED_QUERY for an empty string", () => {
      const result = createQuestionLearningThread(makeInput({ refinedQuery: "" }));
      expect(asFailure(result).reason).toBe("EMPTY_REFINED_QUERY");
    });

    it("returns EMPTY_REFINED_QUERY for whitespace-only", () => {
      const result = createQuestionLearningThread(makeInput({ refinedQuery: "\t\n" }));
      expect(asFailure(result).reason).toBe("EMPTY_REFINED_QUERY");
    });

    it("returns EMPTY_REFINED_QUERY for a non-string refinedQuery", () => {
      const result = createQuestionLearningThread(
        makeInput({ refinedQuery: undefined as unknown as string }),
      );
      expect(asFailure(result).reason).toBe("EMPTY_REFINED_QUERY");
    });
  });

  // ── Validation: createdAt ───────────────────────────────────────────────

  describe("createdAt validation", () => {
    it("returns INVALID_CREATED_AT for a negative number", () => {
      const result = createQuestionLearningThread(makeInput({ createdAt: -1 }));
      expect(asFailure(result).reason).toBe("INVALID_CREATED_AT");
    });

    it("returns INVALID_CREATED_AT for a float", () => {
      const result = createQuestionLearningThread(makeInput({ createdAt: 1.5 }));
      expect(asFailure(result).reason).toBe("INVALID_CREATED_AT");
    });

    it("returns INVALID_CREATED_AT for a non-number", () => {
      const result = createQuestionLearningThread(
        makeInput({ createdAt: "now" as unknown as number }),
      );
      expect(asFailure(result).reason).toBe("INVALID_CREATED_AT");
    });

    it("accepts zero as createdAt", () => {
      const result = createQuestionLearningThread(makeInput({ createdAt: 0 }));
      expect(asSuccess(result).artifact.createdAt).toBe(0);
    });
  });

  // ── Validation: timelineStages ──────────────────────────────────────────

  describe("timelineStages validation", () => {
    it("returns EMPTY_TIMELINE for an empty array", () => {
      const result = createQuestionLearningThread(makeInput({ timelineStages: [] }));
      expect(asFailure(result).reason).toBe("EMPTY_TIMELINE");
    });

    it("returns EMPTY_TIMELINE when timelineStages is not an array", () => {
      const result = createQuestionLearningThread(
        makeInput({ timelineStages: null as unknown as TimelineStageInput[] }),
      );
      expect(asFailure(result).reason).toBe("EMPTY_TIMELINE");
    });

    it("returns INVALID_TIMELINE_STAGE when questionId is non-numeric", () => {
      const stage = makeStage({ questionId: "abc" });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("INVALID_TIMELINE_STAGE");
    });

    it("returns INVALID_TIMELINE_STAGE when answerId is non-numeric", () => {
      const stage = makeStage({ answerId: "xyz" });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("INVALID_TIMELINE_STAGE");
    });

    it("returns INVALID_TIMELINE_STAGE when title is empty", () => {
      const stage = makeStage({ title: "" });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("INVALID_TIMELINE_STAGE");
    });

    it("returns INVALID_TIMELINE_STAGE when authorDisplayName is empty", () => {
      const stage = makeStage({ authorDisplayName: "   " });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("INVALID_TIMELINE_STAGE");
    });

    it("returns INVALID_TIMELINE_STAGE when editTime is not a safe integer", () => {
      const stage = makeStage({ editTime: -1 });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("INVALID_TIMELINE_STAGE");
    });

    it("returns INVALID_TIMELINE_STAGE when canonicalUrl is not a valid Zhihu URL", () => {
      const stage = makeStage({ canonicalUrl: "https://example.com/page" });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("INVALID_TIMELINE_STAGE");
    });

    it("returns EMPTY_EXCERPT when excerpt fingerprint is empty", () => {
      const stage = makeStage({
        excerpt: {
          ...makeStage().excerpt,
          fingerprint: "",
        },
      });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("EMPTY_EXCERPT");
    });

    it("returns EMPTY_EXCERPT when excerpt text is empty", () => {
      const stage = makeStage({
        excerpt: {
          ...makeStage().excerpt,
          excerpt: "   ",
        },
      });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("EMPTY_EXCERPT");
    });

    it("rejects an excerpt content type outside Answer and Article", () => {
      const stage = makeStage({
        excerpt: {
          ...makeStage().excerpt,
          sourceContentType: "Pin" as unknown as "Answer",
        },
      });
      const result = createQuestionLearningThread(makeInput({ timelineStages: [stage] }));
      expect(asFailure(result).reason).toBe("INVALID_TIMELINE_STAGE");
    });

    it("accepts an Article stage with no question id", () => {
      // Column articles carry no question and use the zhuanlan URL shape.
      const stage = makeStage({
        questionId: "",
        answerId: "9001",
        canonicalUrl: "https://zhuanlan.zhihu.com/p/9001",
        excerpt: {
          ...makeStage().excerpt,
          questionId: "",
          answerId: "9001",
          sourceContentType: "Article",
        },
      });
      const node = makeNode({
        sourceAnswerId: "9001",
        sourceUrl: "https://zhuanlan.zhihu.com/p/9001",
        evidenceRefs: [
          { excerptFingerprint: stage.excerpt.fingerprint, quote: stage.excerpt.excerpt },
        ],
      });
      const result = createQuestionLearningThread(
        makeInput({ timelineStages: [stage], learningNodes: [node] }),
      );
      const artifact = asSuccess(result).artifact;
      expect(artifact.timelineStages[0]?.excerpt.sourceContentType).toBe("Article");
      expect(artifact.timelineStages[0]?.questionId).toBe("");
    });

    it("accepts multiple timeline stages totaling different counts", () => {
      const stages = [makeStage(), makeStage({ answerId: "789" })];
      const result = createQuestionLearningThread(makeInput({ timelineStages: stages }));
      expect(asSuccess(result).artifact.timelineStages).toHaveLength(2);
    });
  });

  // ── Validation: learningNodes ───────────────────────────────────────────

  describe("learningNodes validation", () => {
    it("returns EMPTY_LEARNING_NODES for an empty array", () => {
      const result = createQuestionLearningThread(makeInput({ learningNodes: [] }));
      expect(asFailure(result).reason).toBe("EMPTY_LEARNING_NODES");
    });

    it("returns EMPTY_LEARNING_NODES when learningNodes is not an array", () => {
      const result = createQuestionLearningThread(
        makeInput({ learningNodes: null as unknown as LearningNodeInput[] }),
      );
      expect(asFailure(result).reason).toBe("EMPTY_LEARNING_NODES");
    });

    it("returns INVALID_LEARNING_NODE for an invalid kind", () => {
      const node = makeNode({ kind: "invalid_kind" as LearningNodeInput["kind"] });
      const result = createQuestionLearningThread(makeInput({ learningNodes: [node] }));
      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });

    it("returns INVALID_LEARNING_NODE for an empty title", () => {
      const node = makeNode({ title: "" });
      const result = createQuestionLearningThread(makeInput({ learningNodes: [node] }));
      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });

    it("returns INVALID_LEARNING_NODE for an empty summary", () => {
      const node = makeNode({ summary: "   " });
      const result = createQuestionLearningThread(makeInput({ learningNodes: [node] }));
      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });

    it("returns INVALID_LEARNING_NODE for empty evidenceRefs", () => {
      const node = makeNode({ evidenceRefs: [] });
      const result = createQuestionLearningThread(makeInput({ learningNodes: [node] }));
      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });

    it("returns INVALID_LEARNING_NODE for an evidence ref with empty fingerprint", () => {
      const node = makeNode({
        evidenceRefs: [{ excerptFingerprint: "", quote: "some quote" }],
      });
      const result = createQuestionLearningThread(makeInput({ learningNodes: [node] }));
      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });

    it("returns INVALID_LEARNING_NODE for an evidence ref with empty quote", () => {
      const node = makeNode({
        evidenceRefs: [{ excerptFingerprint: "v1:aa", quote: "   " }],
      });
      const result = createQuestionLearningThread(makeInput({ learningNodes: [node] }));
      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });

    it("returns INVALID_LEARNING_NODE for an invalid sourceUrl", () => {
      const node = makeNode({ sourceUrl: "https://example.com/something" });
      const result = createQuestionLearningThread(makeInput({ learningNodes: [node] }));
      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });

    it("returns INVALID_LEARNING_NODE when a node declares a source it does not cite", () => {
      const stageA = makeStage();
      const stageB = makeStage({
        answerId: "789",
        title: "Second Answer",
        canonicalUrl: "https://www.zhihu.com/question/123/answer/789",
        excerpt: {
          questionId: "123",
          answerId: "789",
          capturedAt: 1_700_000_000_000,
          sourceContentId: "src-2",
          sourceContentType: "Answer",
          sourceEditTime: 1_700_000_000_000,
          excerpt: "A different excerpt from the second answer.",
          fingerprint: "v1:bbbbbbbbbbbbbbbb",
        },
      });
      // The node quotes the first answer but claims the second one as its source.
      const node = makeNode({
        sourceAnswerId: "789",
        sourceUrl: "https://www.zhihu.com/question/123/answer/789",
      });

      const result = createQuestionLearningThread(
        makeInput({ timelineStages: [stageA, stageB], learningNodes: [node] }),
      );

      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });

    it("accepts a node whose declared source is among its own citations", () => {
      const result = createQuestionLearningThread(makeInput({ learningNodes: [makeNode()] }));
      const artifact = asSuccess(result).artifact;

      expect(artifact.learningNodes).toHaveLength(1);
      expect(artifact.learningNodes[0]?.sourceAnswerId).toBe("456");
      expect(artifact.learningNodes[0]?.evidenceRefs[0]?.excerptFingerprint).toBe(
        "v1:aaaaaaaaaaaaaaaa",
      );
    });

    it.each([
      { value: -0.1, label: "below 0" },
      { value: 1.1, label: "above 1" },
      { value: NaN, label: "NaN" },
      { value: Infinity, label: "Infinity" },
    ])("returns INVALID_LEARNING_NODE for uncertainty $label ($value)", ({ value }) => {
      const node = makeNode({ uncertainty: value });
      const result = createQuestionLearningThread(makeInput({ learningNodes: [node] }));
      expect(asFailure(result).reason).toBe("INVALID_LEARNING_NODE");
    });
  });

  // ── Validation: overall uncertainty ────────────────────────────────────

  describe("overall uncertainty validation", () => {
    it("returns INVALID_UNCERTAINTY for a value below 0", () => {
      const result = createQuestionLearningThread(makeInput({ uncertainty: -1 }));
      expect(asFailure(result).reason).toBe("INVALID_UNCERTAINTY");
    });

    it("returns INVALID_UNCERTAINTY for a value above 1", () => {
      const result = createQuestionLearningThread(makeInput({ uncertainty: 5 }));
      expect(asFailure(result).reason).toBe("INVALID_UNCERTAINTY");
    });

    it("returns INVALID_UNCERTAINTY for NaN", () => {
      const result = createQuestionLearningThread(makeInput({ uncertainty: NaN }));
      expect(asFailure(result).reason).toBe("INVALID_UNCERTAINTY");
    });

    it("accepts uncertainty of exactly 0", () => {
      const result = createQuestionLearningThread(makeInput({ uncertainty: 0 }));
      expect(asSuccess(result).artifact.uncertainty).toBe(0);
    });

    it("accepts uncertainty of exactly 1", () => {
      const result = createQuestionLearningThread(makeInput({ uncertainty: 1 }));
      expect(asSuccess(result).artifact.uncertainty).toBe(1);
    });
  });

  // ── sortLearningNodes ──────────────────────────────────────────────────

  describe("sortLearningNodes", () => {
    it("sorts nodes according to the LEARNING_NODE_ORDER", () => {
      const input = [
        makeNode({ kind: "evolution" }),
        makeNode({ kind: "cause" }),
        makeNode({ kind: "unknown" }),
        makeNode({ kind: "consensus" }),
      ];
      const sorted = sortLearningNodes(input);

      expect(sorted.map((n) => n.kind)).toEqual(["cause", "consensus", "evolution", "unknown"]);
    });

    it("places relationship and divergence correctly in the ordering", () => {
      const input = [
        makeNode({ kind: "divergence" }),
        makeNode({ kind: "relationship" }),
        makeNode({ kind: "changed_premise" }),
      ];
      const sorted = sortLearningNodes(input);

      expect(sorted.map((n) => n.kind)).toEqual(["relationship", "divergence", "changed_premise"]);
    });

    it("places unknown kinds at the end", () => {
      const input = [
        makeNode({ kind: "relationship" }),
        makeNode({ kind: "unknown" }),
        makeNode({ kind: "unknown" }),
      ];
      const sorted = sortLearningNodes(input);

      expect(sorted[0].kind).toBe("relationship");
      expect(sorted[1].kind).toBe("unknown");
      expect(sorted[2].kind).toBe("unknown");
    });

    it("does not mutate the input array", () => {
      const input = [makeNode({ kind: "divergence" }), makeNode({ kind: "cause" })];
      const before = input.map((n) => n.kind);
      sortLearningNodes(input);
      expect(input.map((n) => n.kind)).toEqual(before);
    });

    it("returns a new array instance", () => {
      const input = [makeNode({ kind: "cause" })];
      const sorted = sortLearningNodes(input);
      expect(sorted).not.toBe(input);
    });

    it("is stable for nodes of the same kind", () => {
      const input = [
        makeNode({ kind: "cause", title: "First" }),
        makeNode({ kind: "cause", title: "Second" }),
      ];
      const sorted = sortLearningNodes(input);
      expect(sorted[0].title).toBe("First");
      expect(sorted[1].title).toBe("Second");
    });
  });

  // ── extractZhihuQuestionId ─────────────────────────────────────────────

  describe("extractZhihuQuestionId", () => {
    it("extracts the ID from a standard Zhihu question URL", () => {
      expect(extractZhihuQuestionId("https://www.zhihu.com/question/123456/answer/789")).toBe(
        "123456",
      );
    });

    it("extracts the ID from a URL without www", () => {
      expect(extractZhihuQuestionId("https://zhihu.com/question/42/answer/100")).toBe("42");
    });

    it("returns null for a non-matching URL", () => {
      expect(extractZhihuQuestionId("https://example.com/")).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(extractZhihuQuestionId("")).toBeNull();
    });

    it("does not match answer-only URLs", () => {
      expect(extractZhihuQuestionId("https://www.zhihu.com/question/42/answer/100")).toBe("42");
    });
  });

  // ── extractZhihuAnswerId ───────────────────────────────────────────────

  describe("extractZhihuAnswerId", () => {
    it("extracts the ID from a standard Zhihu answer URL", () => {
      expect(extractZhihuAnswerId("https://www.zhihu.com/question/123456/answer/789")).toBe("789");
    });

    it("extracts the ID from a URL without www", () => {
      expect(extractZhihuAnswerId("https://zhihu.com/question/42/answer/100")).toBe("100");
    });

    it("returns null for a URL without an answer ID segment at the end", () => {
      expect(extractZhihuAnswerId("https://www.zhihu.com/question/42")).toBeNull();
    });

    it("returns null for a completely non-matching URL", () => {
      expect(extractZhihuAnswerId("https://example.com/page")).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(extractZhihuAnswerId("")).toBeNull();
    });
  });
});
