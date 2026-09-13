import assert from "node:assert/strict";
import type { Bindings } from "./bridge.ts";
import { createBridge, normalizeArtifact } from "./bridge.ts";
import { installNetwork } from "./network.ts";
import { runCase } from "./runner.ts";
import { taskOf } from "./fixtures.ts";
const rawSource = (id: string) => ({
  questionId: "100",
  answerId: id,
  title: "合成索引材料",
  authorDisplayName: `测试作者${id}`,
  editTime: 1,
  canonicalUrl: `https://example.invalid/${id}`,
  excerpt: {
    questionId: "100",
    answerId: id,
    capturedAt: 1,
    sourceContentId: id,
    sourceContentType: "Answer",
    sourceEditTime: 1,
    excerpt: "索引减少扫描。写入需要维护索引。",
    fingerprint: `fixture-${id}`,
  },
});
export const rawThread = () => ({
  threadId: "0123456789abcdef",
  timelineStages: [rawSource("101"), rawSource("102")],
  learningNodes: [
    {
      title: "索引取舍",
      summary: "索引减少扫描。写入需要维护索引。",
      sourceAnswerId: "101",
      sourceUrl: "https://example.invalid/101",
      evidenceRefs: [
        { excerptFingerprint: "fixture-101", quote: "索引减少扫描。" },
        { excerptFingerprint: "fixture-102", quote: "写入需要维护索引。" },
      ],
    },
  ],
  learningGuide: {
    overview: {
      headline: "索引",
      summary: "索引减少扫描。",
      evidenceRefs: [{ excerptFingerprint: "fixture-101", quote: "索引减少扫描。" }],
    },
    stages: [],
    openQuestions: [],
  },
});
const bindingsOf = (): Bindings => ({
  diagnostics: [],
  seed: async () => {},
  clarify: async ({ question }) => ({
    success: true,
    refinedQuery: question,
    alternatives: ["索引"],
    learningIntent: "解释索引",
    guidance: "比较条件",
  }),
  search: async () => ({
    status: "ok",
    candidates: ["101", "102"].map((id) => ({
      questionId: "100",
      answerId: id,
      sourceContentType: "Answer",
      title: "合成索引材料",
      url: `https://example.invalid/${id}`,
      authorDisplayName: `测试作者${id}`,
      editAt: 1,
      excerptFingerprint: `fixture-${id}`,
    })),
  }),
  rank: async () => ({
    success: true,
    analysis: {
      summary: "比较索引",
      rankings: [
        { answerId: "101", role: "baseline", reason: "基础说明" },
        { answerId: "102", role: "counterpoint", reason: "补充成本" },
      ],
    },
  }),
  generate: async () => ({ success: true, threadId: "0123456789abcdef", mode: "synthesized" }),
  read: async () => ({ success: true, artifact: rawThread() }),
  ask: async () => ({
    success: true,
    response: {
      status: "grounded",
      answer: "索引减少扫描。",
      evidenceRefs: [
        {
          answerId: "101",
          excerptFingerprint: "fixture-101",
          quote: "索引减少扫描。",
          sourceUrl: "https://example.invalid/101",
        },
      ],
      nextActions: [],
    },
  }),
  excerpt: async (_qid, id) => rawSource(id).excerpt,
});
const withBridge = async (mutate: (bindings: Bindings) => void = () => {}) => {
  const network = installNetwork({
    live: false,
    origins: ["https://example.invalid"],
    maxRunCalls: 10,
  });
  const bindings = bindingsOf();
  mutate(bindings);
  try {
    return await runCase(taskOf(), {
      createPort: async () =>
        createBridge(bindings, network, async () => {
          throw Error("No live model in bridge contracts");
        }),
    });
  } finally {
    network.restore();
  }
};
export const bridgeContracts = [
  {
    name: "bridge normalizes the current product response shapes",
    run: async () => {
      const r = await withBridge();
      assert.equal(r.firstAttemptRulesPass, true);
      assert.equal(r.finalVerdict, "unjudged");
    },
  },
  {
    name: "bridge preserves explicit Agent reference misbindings",
    run: async () => {
      const r = await withBridge((b) => {
        b.ask = async () => ({
          success: true,
          response: {
            status: "grounded",
            answer: "索引减少扫描。",
            evidenceRefs: [
              {
                answerId: "102",
                excerptFingerprint: "fixture-101",
                quote: "索引减少扫描。",
                sourceUrl: "https://example.invalid/102",
              },
            ],
            nextActions: [],
          },
        });
      });
      assert.equal(r.attempts[0].grade.metrics.quoteContainment, true);
      assert.equal(r.attempts[0].grade.metrics.sourceBinding, false);
    },
  },
  {
    name: "cross-source node citations resolve each fingerprint independently",
    run: () => {
      const artifact = normalizeArtifact(rawThread(), "synthesized");
      assert.deepEqual(
        artifact.units[0].citations.map((r) => r.sourceId),
        ["101", "102"],
      );
    },
  },
  {
    name: "bridge rejects a cached excerpt version different from the selected candidate",
    run: async () => {
      const r = await withBridge((b) => {
        b.excerpt = async (_qid, id) => ({ ...rawSource(id).excerpt, fingerprint: "changed" });
      });
      assert.equal(r.firstAttemptRulesPass, false);
      assert.equal(r.attempts[0].execution.error?.code, "EXCERPT_VERSION_MISMATCH");
    },
  },
  {
    name: "successful clarification and ranking explanations are graded",
    run: async () => {
      const r = await withBridge();
      const text = r.attempts[0].grade.units.map((u) => u.text).join("\n");
      assert.ok(text.includes("比较条件"));
      assert.ok(text.includes("补充成本"));
    },
  },
  {
    name: "bridge retains evidence-only generation mode",
    run: async () => {
      const r = await withBridge((b) => {
        b.generate = async () => ({
          success: true,
          threadId: "0123456789abcdef",
          mode: "evidence_only",
        });
      });
      assert.equal(r.attempts[0].execution.artifact?.mode, "evidence_only");
    },
  },
  {
    name: "invalid product Agent status is not converted to an answered result",
    run: async () => {
      const r = await withBridge((b) => {
        b.ask = async () => ({ success: true, response: { status: "invented" } });
      });
      assert.equal(r.firstAttemptRulesPass, false);
      assert.equal(r.attempts[0].execution.error?.code, "INVALID_AGENT_STATUS");
    },
  },
].map((item, index) => ({
  ...item,
  id: `reg-bridge-${index + 1}`,
  affectedPaths: ["src/evals/v3/bridge.ts"],
}));
