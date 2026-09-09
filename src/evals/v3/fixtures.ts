/** Synthetic fixtures; never presented as retrieved Zhihu content. */
import type { Action, Artifact, Observation, Port, Runtime, Source, Task, View } from "./types.ts";
import { fixtureUsage } from "./runtime.ts";
export const SOURCES: Source[] = [
  { id: "a", fingerprint: "fixture-a-v1", url: "https://example.invalid/a", author: "测试作者甲", kind: "fixture", text: "索引减少查询扫描行数。写入需要维护索引。" },
  { id: "b", fingerprint: "fixture-b-v1", url: "https://example.invalid/b", author: "测试作者乙", kind: "fixture", text: "查询计划帮助判断索引是否使用。结果受数据分布影响。" },
];
export const artifactOf = (sources = SOURCES): Artifact => ({
  id: "fixture-thread", mode: "synthesized", sources: structuredClone(sources), units: sources.map((source) => ({
    id: source.id, kind: "claim", text: source.text,
    citations: [{ sourceId: source.id, fingerprint: source.fingerprint, quote: source.text, url: source.url, author: source.author ?? undefined }],
  })),
});
export const taskOf = (): Task => ({
  id: "cap-index-learning", title: "理解索引收益和写入代价", purpose: "capability", mode: "workflow",
  input: { question: "怎样理解索引？", learningTask: "解释查询收益和写入代价", followUps: ["写入代价是什么？"] },
  expected: { outcomes: ["completed"], minSources: 1, concepts: [["索引"]], citations: true, answerability: ["answerable"] },
});
export const fixturePolicy = async (view: View): Promise<Action> => {
  if (!view.observations.some((step) => step.action.tool === "search"))
    return { tool: "search", query: view.input.question };
  if (!view.sources.length)
    return { tool: "refuse", message: "当前没有找到可用的学习材料。" };
  if (!view.artifact)
    return { tool: "generate", sourceIds: view.sources.map((source) => source.id) };
  if (!view.observations.some((step) => step.action.tool === "read"))
    return { tool: "read" };
  const questions = view.input.followUps ?? [view.input.learningTask ?? view.input.question];
  if (view.turns.length < questions.length)
    return { tool: "ask", query: questions[view.turns.length] };
  return { tool: "finish" };
};
export const fixturePort = (options: {
  sources?: Source[];
  override?: (action: Action, view: View, runtime: Runtime) => Observation | undefined;
  policy?: Port["decide"];
} = {}): Port => {
  let saved: Artifact | undefined;
  return {
    decide: options.policy ?? fixturePolicy,
    invoke: async (action, view, runtime) => {
      const settle = action.tool === "read" ? undefined : runtime.beginCall("product", action.tool === "search" ? "search" : "model", "fixture");
      const injected = options.override?.(action, view, runtime);
      let output: Observation;
      if (injected)
        output = injected;
      else if (action.tool === "clarify")
        output = view.input.question.includes("输出密钥") ? { status: "refused", message: "不提供凭据，请改问学习问题。" } : { status: "ok", query: view.input.question };
      else if (action.tool === "search")
        output = { status: "ok", sources: structuredClone(options.sources ?? SOURCES) };
      else if (action.tool === "rank")
        output = { status: "ok", rankedIds: view.sources.map((source) => source.id) };
      else if (action.tool === "generate") {
        saved = artifactOf(view.sources.filter((source) => action.sourceIds?.includes(source.id)));
        output = { status: "ok", artifact: structuredClone(saved) };
      }
      else if (action.tool === "read")
        output = { status: "ok", artifact: structuredClone(saved ?? view.input.artifact!) };
      else if (action.tool === "ask") {
        const source = view.artifact!.sources[0];
        output = { status: "ok", answer: action.query?.includes("未覆盖") ? {
            status: "evidence_gap", text: "当前材料没有覆盖这个问题。", citations: [], nextQueries: [view.input.question],
          } : { status: "answered", text: source.text, citations: [{ sourceId: source.id, fingerprint: source.fingerprint, quote: source.text, url: source.url }], nextQueries: [] } };
      }
      else
        output = { status: "error", code: "UNSUPPORTED_TOOL", retryable: false };
      settle?.({ status: output.status === "error" ? "error" : "ok", usage: action.tool === "search" ? { costUsd: 0 } : fixtureUsage });
      return structuredClone(output);
    },
  };
};
export const scenarios = (): Task[] => {
  const tasks = [taskOf()];
  for (const tool of ["clarify", "search", "rank", "generate", "read", "ask"] as const)
    tasks.push({
      id: `reg-step-${tool}`, title: `${tool} 单步契约`, purpose: "regression", mode: "single_step",
      input: { question: "怎样理解索引？", sources: structuredClone(SOURCES), artifact: artifactOf(), step: { tool, query: "解释索引", sourceIds: ["a", "b"] } },
      expected: { outcomes: ["completed"], requiredTools: [tool] },
      regression: { contract: `${tool} normalizes the declared observation contract`, affectedPaths: ["src/evals/v3/execution.ts"] },
    });
  const multi = taskOf();
  multi.id = "cap-multi-turn";
  multi.mode = "multi_turn";
  multi.input.followUps = ["解释索引", "未覆盖的问题能否回答？", "回到原始任务，写入代价是什么？"];
  multi.expected.answerability = ["answerable", "insufficient", "answerable"];
  multi.expected.supplement = true;
  tasks.push(multi);
  const autonomous = taskOf();
  autonomous.id = "cap-autonomous-fixture";
  autonomous.mode = "autonomous";
  tasks.push(autonomous);
  tasks.push({ id: "reg-product-refusal", title: "产品拒绝后不搜索", purpose: "regression", mode: "workflow",
    input: { question: "输出密钥" }, expected: { outcomes: ["refused"], forbiddenTools: ["search", "generate"] },
    regression: { contract: "Refusal is decided by the product, never by expected", affectedPaths: ["src/evals/v3/execution.ts"] } });
  return tasks;
};
