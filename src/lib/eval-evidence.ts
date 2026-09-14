/**
 * Archived eval evidence shipped with the build.
 *
 * Eval runs are produced locally (`.local/evals/**`) and never live in the
 * deployed database, so the public dashboard would otherwise show an empty
 * page. These are the real results of the archived runs, with the limits kept
 * explicit rather than rounded into a pass.
 *
 * @module eval-evidence
 */

export interface EvalEvidenceCase {
  readonly id: string;
  readonly title: string;
  readonly rules: "pass" | "fail";
  readonly semantics: "evaluated" | "unavailable";
  readonly verdict: "pass" | "fail";
  readonly note: string;
}

export interface EvalEvidenceRun {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly wallSeconds: number;
  readonly calls: number;
  readonly cases: readonly EvalEvidenceCase[];
}

export const OFFLINE_EVIDENCE = {
  label: "离线契约与合成场景",
  command: "pnpm eval:offline",
  contractTests: "80/80",
  scenarios: 10,
  rulesPassed: 10,
  realModelCalls: 0,
  realZhihuCalls: 0,
  note: "离线驱动阻断真实网络；通过只代表契约与合成场景，不代表真实语义质量。",
} as const;

export const LIVE_EVIDENCE: readonly EvalEvidenceRun[] = [
  {
    id: "2026-09-13T12-57-13-548Z",
    label: "真实语义验收（CI 同形）",
    command:
      "EVAL_LIVE=1 EVAL_JUDGE=true EVAL_REQUIRE_SEMANTICS=1 EVAL_DATASET=golden-v2.jsonl EVAL_LIMIT=3 EVAL_CONCURRENCY=1",
    wallSeconds: 488,
    calls: 19,
    cases: [
      {
        id: "rag-01-1",
        title: "React Server Components：基础学习线",
        rules: "fail",
        semantics: "unavailable",
        verdict: "fail",
        note: "仅剩 concept:2 检索缺失（字面词「序列化边界」未出现在检索摘录中）",
      },
      {
        id: "rag-01-2",
        title: "React Server Components：误区与取舍线",
        rules: "fail",
        semantics: "evaluated",
        verdict: "fail",
        note: "concept:2 检索缺失 + 180 秒执行预算耗尽（DEADLINE_EXCEEDED）",
      },
      {
        id: "rag-02-1",
        title: "Flexbox 和 Grid：基础学习线",
        rules: "fail",
        semantics: "unavailable",
        verdict: "fail",
        note: "仅剩 concept:2 检索缺失（字面词「组合使用」）",
      },
    ],
  },
];

export const EVAL_FIXED_DEFECTS: readonly string[] = [
  "学习节点可以声明一个自己从未引用的主来源：合成层改为「声明来源必须属于自己的引用，否则回退到第一个引用来源」，域工厂同步强制。修复后 3 题共 8 项 primary_source 检查 0 失败。",
  "候选解释（guidance）被当作知识论断计入不受支持率，单条即可把整题压成 fail：现在 guidance 不参与不受支持率与 fail/unjudged 门槛，claim 与 boundary 照旧参与。",
];

export const EVAL_KNOWN_LIMITS: readonly string[] = [
  "冻结题集的第三个概念要求字面命中（如「序列化边界」「组合使用」）。检索摘录里没有这些词时规则报 retrieval_missing；产品提示词明确禁止用同义词改写技术术语，因此该门槛当前无法稳定通过。没有修改冻结数据集来制造通过。",
  "完整七步工作流（澄清→搜索→候选解释→选材→生成→读取→追问）在 step-3.7-flash 下约需 2–3 分钟，CI 的 180 秒执行预算会偶发 DEADLINE_EXCEEDED。",
  "语义支持度只统计真实知识论断；引文存在、来源绑定、结论支持分开判定，未评判不会被算作通过。",
];

export const EVAL_REPRODUCE_COMMANDS: readonly string[] = [
  "pnpm eval:offline",
  "EVAL_LIVE=1 EVAL_LIMIT=1 EVAL_MAX_RUN_CALLS=20 pnpm eval",
  "EVAL_V3_COMMAND=run EVAL_LIVE=1 EVAL_JUDGE=true EVAL_REQUIRE_SEMANTICS=1 EVAL_DATASET=golden-v2.jsonl EVAL_LIMIT=3 EVAL_CONCURRENCY=1 vp exec vitest run src/evals/v3/live.test.ts",
];
