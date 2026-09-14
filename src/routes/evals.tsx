import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readEvalDashboardFn } from "../server/read-eval-dashboard";
import type { EvalDashboard, EvalRunBrief } from "../evals/eval-report-store";
import {
  EVAL_FIXED_DEFECTS,
  EVAL_KNOWN_LIMITS,
  EVAL_REPRODUCE_COMMANDS,
  LIVE_EVIDENCE,
  OFFLINE_EVIDENCE,
} from "../lib/eval-evidence";

export const Route = createFileRoute("/evals")({
  head: () => ({
    meta: [
      { title: "Eval Dashboard · Zhihu Threads" },
      {
        name: "description",
        content: "真实工作流评测结果、失败分布和可回放的执行 trace。",
      },
    ],
    links: [
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon.png" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
    ],
  }),
  component: EvalDashboardPage,
});

const STATUS_LABELS: Record<string, string> = {
  pass: "通过",
  weak: "偏弱",
  fail: "失败",
};

const STATUS_COLORS: Record<string, string> = {
  pass: "bg-success-soft text-success",
  weak: "bg-update-soft text-update",
  fail: "bg-danger-soft text-danger",
};

const CATEGORY_LABELS: Record<string, string> = {
  rag_qa: "RAG 问答",
  tool_call: "工具调用",
  multi_turn: "多轮对话",
  bug_regression: "Bug 回归",
  adversarial: "对抗安全",
};

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
};

const METRIC_LABELS: Record<string, string> = {
  workflowComplete: "工作流完整",
  requiredToolsUsed: "工具调用",
  evidenceGrounded: "证据精确",
  noPromptInjection: "未注入成功",
  noSecretLeak: "无密钥泄露",
  safeBehavior: "安全行为",
  outputValid: "输出有效",
  similarity: "概念覆盖",
  judgeScore: "Judge 分数",
  agentGapRate: "追问证据缺口率",
  conceptSynonymCovered: "概念同义词已覆盖",
  conceptRealGap: "概念真缺口",
};

const toPercent = (value: number): string => `${Math.round(value * 100)}%`;

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

function StatusChip({ status }: { readonly status: string }) {
  return (
    <span
      className={`inline-flex min-h-7 items-center border border-rule-strong px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] ${
        STATUS_COLORS[status] ?? "bg-paper-2 text-ink"
      }`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function StatCard({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <div className="border border-rule bg-paper-3 p-4 shadow-[var(--shadow-card)]">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-2 font-display text-2xl font-bold leading-8 text-ink">{value}</p>
      {detail && <p className="mt-1 truncate text-xs text-muted">{detail}</p>}
    </div>
  );
}

function CoverageRow({
  label,
  executed,
  passed,
  total,
}: {
  readonly label: string;
  readonly executed: number;
  readonly passed: number;
  readonly total: number;
}) {
  const rate = executed === 0 ? 0 : passed / executed;
  const executedPercent = total === 0 ? 0 : (executed / total) * 100;

  return (
    <div>
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-ink">{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {executed}/{total} · 通过 {toPercent(rate)}
        </span>
      </div>
      <div className="relative mt-2 h-2 w-full bg-rule">
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-rule-strong/20"
          style={{ width: `${executedPercent}%` }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-accent"
          style={{ width: `${executedPercent * rate}%` }}
        />
      </div>
    </div>
  );
}

function PanelHeader({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">{eyebrow}</p>
      <h2 className="mt-2 text-lg font-semibold leading-7 text-ink">{title}</h2>
      {description && <p className="mt-1 text-sm leading-6 text-ink-subtle">{description}</p>}
    </div>
  );
}

const DONUT_RADIUS = 54;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

function ResultDonut({
  passed,
  weak,
  failed,
  successRate,
}: {
  readonly passed: number;
  readonly weak: number;
  readonly failed: number;
  readonly successRate: number;
}) {
  const total = Math.max(1, passed + weak + failed);
  const segments = [
    { count: passed, color: "var(--color-success)", label: "通过" },
    { count: weak, color: "var(--color-update)", label: "偏弱" },
    { count: failed, color: "var(--color-danger)", label: "失败" },
  ];
  let offset = 0;

  return (
    <div className="flex min-w-0 items-center gap-5">
      <svg
        viewBox="0 0 140 140"
        className="h-36 w-36 shrink-0"
        role="img"
        aria-label="通过结果分布"
      >
        <circle
          cx="70"
          cy="70"
          r={DONUT_RADIUS}
          className="fill-none stroke-rule"
          strokeWidth="16"
        />
        {segments.map((segment) => {
          const fraction = segment.count / total;
          const length = fraction * DONUT_CIRCUMFERENCE;
          const dash = `${length} ${DONUT_CIRCUMFERENCE - length}`;
          const element = (
            <circle
              key={segment.label}
              cx="70"
              cy="70"
              r={DONUT_RADIUS}
              fill="none"
              stroke={segment.color}
              strokeWidth="16"
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform="rotate(-90 70 70)"
            />
          );
          offset += length;
          return element;
        })}
        <text
          x="70"
          y="66"
          textAnchor="middle"
          className="fill-ink font-display text-2xl font-bold"
        >
          {toPercent(successRate)}
        </text>
        <text
          x="70"
          y="88"
          textAnchor="middle"
          className="fill-muted font-mono text-[10px] uppercase"
        >
          PASS RATE
        </text>
      </svg>
      <div className="min-w-0 space-y-2">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2 w-4" style={{ background: segment.color }} />
            <span className="text-sm text-ink">{segment.label}</span>
            <span className="font-mono text-xs text-muted">{segment.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendChart({ runs }: { readonly runs: readonly EvalRunBrief[] }) {
  const chronological = [...runs].sort(
    (left, right) => Date.parse(left.finishedAt) - Date.parse(right.finishedAt),
  );
  if (chronological.length === 0) return null;

  const width = 720;
  const height = 180;
  const padding = 32;
  const points = chronological.map((run, index) => {
    const x =
      chronological.length === 1
        ? width / 2
        : padding + (index / (chronological.length - 1)) * (width - padding * 2);
    const y = height - padding - run.successRate * (height - padding * 2);
    return { x, y, run };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${padding},${height - padding} ${line} ${width - padding},${height - padding}`;

  return (
    <div className="min-w-0 overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-48 w-full min-w-[520px]"
        role="img"
        aria-label="历史通过率趋势"
      >
        <line
          x1={padding}
          y1={height - padding}
          x2={width - padding}
          y2={height - padding}
          className="stroke-rule"
          strokeWidth="2"
        />
        <line
          x1={padding}
          y1={padding}
          x2={padding}
          y2={height - padding}
          className="stroke-rule"
          strokeWidth="2"
        />
        <polygon points={area} className="fill-accent/10" />
        <polyline
          points={line}
          className="fill-none stroke-accent"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {points.map((point) => (
          <g key={point.run.runId}>
            <circle
              cx={point.x}
              cy={point.y}
              r="5"
              className="fill-paper-3 stroke-accent"
              strokeWidth="3"
            />
            <title>{`${point.run.runId} · ${toPercent(point.run.successRate)}`}</title>
          </g>
        ))}
        <text x={padding} y={22} className="fill-muted font-mono text-[11px]">
          100%
        </text>
        <text x={padding} y={height - 10} className="fill-muted font-mono text-[11px]">
          {chronological[0].finishedAt.slice(5, 16).replace("T", " ")}
        </text>
        <text
          x={width - padding}
          y={height - 10}
          textAnchor="end"
          className="fill-muted font-mono text-[11px]"
        >
          {chronological[chronological.length - 1].finishedAt.slice(5, 16).replace("T", " ")}
        </text>
      </svg>
    </div>
  );
}

function StackedQualityChart({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly passed: number;
    readonly weak: number;
    readonly failed: number;
  }>;
}) {
  return (
    <div className="border border-rule bg-paper-3 p-5 shadow-[var(--shadow-card)]">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <div className="mt-4 space-y-4">
        {rows.map((row) => {
          const total = Math.max(1, row.passed + row.weak + row.failed);
          return (
            <div key={row.key}>
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium text-ink">{row.label}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted">
                  {row.passed}/{row.passed + row.weak + row.failed}
                </span>
              </div>
              <div className="mt-2 flex h-3 w-full overflow-hidden bg-rule">
                <div className="bg-success" style={{ width: `${(row.passed / total) * 100}%` }} />
                <div className="bg-update" style={{ width: `${(row.weak / total) * 100}%` }} />
                <div className="bg-danger" style={{ width: `${(row.failed / total) * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TracePre({ value, label }: { readonly value?: string; readonly label: string }) {
  if (!value || value === "null") return null;
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.10em] text-muted">{label}</p>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words border border-rule bg-paper-2 p-3 font-mono text-[11px] leading-5 text-ink-subtle">
        {value}
      </pre>
    </div>
  );
}

function RunSelect({
  runs,
  value,
  onChange,
}: {
  readonly runs: readonly EvalRunBrief[];
  readonly value?: string;
  readonly onChange: (runId: string) => void;
}) {
  return (
    <label className="min-w-0 flex-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">选择运行</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-11 w-full border-2 border-rule-strong bg-paper-3 px-3 text-sm text-ink focus:border-accent focus:outline-none"
      >
        {runs.map((run) => (
          <option key={run.runId} value={run.runId}>
            {run.runId} · {toPercent(run.successRate)}
          </option>
        ))}
      </select>
    </label>
  );
}

function EvalDashboardPage() {
  const readDashboard = useServerFn(readEvalDashboardFn);
  const [dashboard, setDashboard] = useState<EvalDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [difficultyFilter, setDifficultyFilter] = useState("all");
  const [search, setSearch] = useState("");

  const load = useCallback(
    async (runId?: string, caseId?: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await readDashboard({ data: { runId, caseId } });
        setDashboard(result);
        setSelectedRunId(result.selectedRunId);
      } catch {
        setError("无法加载 eval dashboard，请稍后再试。");
      } finally {
        setLoading(false);
      }
    },
    [readDashboard],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const summary = dashboard?.summary;
  const cases = dashboard?.cases ?? [];
  const filteredCases = useMemo(() => {
    const query = search.trim().toLowerCase();
    return cases.filter((item) => {
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
      if (difficultyFilter !== "all" && item.difficulty !== difficultyFilter) return false;
      if (!query) return true;
      return (
        item.caseId.toLowerCase().includes(query) ||
        (item.threadId ?? "").toLowerCase().includes(query) ||
        item.failures.some((failure) => failure.toLowerCase().includes(query))
      );
    });
  }, [cases, categoryFilter, difficultyFilter, search, statusFilter]);

  const categories = useMemo(
    () => Array.from(new Set(cases.map((item) => item.category))).sort(),
    [cases],
  );
  const difficulties = useMemo(
    () => Array.from(new Set(cases.map((item) => item.difficulty))).sort(),
    [cases],
  );

  const selectRun = (runId: string) => {
    setStatusFilter("all");
    setCategoryFilter("all");
    setDifficultyFilter("all");
    setSearch("");
    void load(runId);
  };

  const selectCase = (caseId: string) => {
    void load(selectedRunId, caseId);
  };

  if (loading && !dashboard) {
    return (
      <main className="min-h-screen bg-paper pb-20 text-ink">
        <div className="mx-auto w-full max-w-[1120px] px-5 pt-10 sm:px-8">
          <div className="space-y-4">
            <div className="h-9 w-2/3 animate-pulse bg-paper-3" />
            <div className="h-36 w-full animate-pulse border border-rule bg-paper-3" />
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[0, 1, 2, 3].map((item) => (
                <div key={item} className="h-24 animate-pulse bg-paper-3" />
              ))}
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (error || !dashboard || dashboard.status !== "ok" || !summary) {
    return (
      <main className="min-h-screen bg-paper pb-20 text-ink">
        <div className="mx-auto w-full max-w-[1120px] px-5 pt-10 sm:px-8">
          <header className="max-w-3xl">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">
              EVAL EVIDENCE
            </p>
            <h1 className="mt-3 font-display text-[32px] font-bold leading-10 tracking-tight sm:text-[40px]">
              评测证据
            </h1>
            <p className="mt-3 text-base leading-7 text-ink-subtle">
              评测运行写在本地 SQLite，公网实例上没有那份数据，所以这里展示随版本归档的真实结果：
              离线契约、真实语义验收，以及两处由评测发现并已修复的缺陷。未通过的项照实列出。
            </p>
          </header>

          <section className="mt-8 border-2 border-rule-strong bg-paper-3 p-5 shadow-[var(--shadow-card)] sm:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-display text-xl font-bold">{OFFLINE_EVIDENCE.label}</h2>
              <code className="font-mono text-[11px] text-muted">{OFFLINE_EVIDENCE.command}</code>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[
                { label: "契约测试", value: OFFLINE_EVIDENCE.contractTests },
                { label: "合成场景", value: `${OFFLINE_EVIDENCE.scenarios}` },
                { label: "规则通过", value: `${OFFLINE_EVIDENCE.rulesPassed}` },
                {
                  label: "真实调用",
                  value: `${OFFLINE_EVIDENCE.realModelCalls + OFFLINE_EVIDENCE.realZhihuCalls}`,
                },
              ].map((item) => (
                <div key={item.label} className="border border-rule bg-paper-2 px-3 py-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                    {item.label}
                  </p>
                  <p className="mt-1 text-2xl font-bold">{item.value}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm leading-6 text-ink-subtle">{OFFLINE_EVIDENCE.note}</p>
          </section>

          {LIVE_EVIDENCE.map((run) => (
            <section
              key={run.id}
              className="mt-6 border-2 border-rule-strong bg-paper-3 p-5 shadow-[var(--shadow-card)] sm:p-6"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="font-display text-xl font-bold">{run.label}</h2>
                <p className="font-mono text-[11px] text-muted">
                  {run.calls} 次调用 · {run.wallSeconds}s · 单并发
                </p>
              </div>
              <code className="mt-3 block break-all font-mono text-[11px] leading-5 text-muted">
                {run.command}
              </code>

              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b-2 border-rule-strong font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                      <th className="py-2 pr-4">用例</th>
                      <th className="py-2 pr-4">规则</th>
                      <th className="py-2 pr-4">语义</th>
                      <th className="py-2 pr-4">判定</th>
                      <th className="py-2">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.cases.map((item) => (
                      <tr key={item.id} className="border-b border-rule align-top">
                        <td className="py-3 pr-4">
                          <p className="font-mono text-[11px] text-muted">{item.id}</p>
                          <p className="mt-1 font-medium">{item.title}</p>
                        </td>
                        <td className="py-3 pr-4">
                          <span
                            className={
                              "inline-flex min-h-7 items-center border px-2 font-mono text-[10px] font-semibold " +
                              (item.rules === "pass"
                                ? "border-success bg-success-soft text-success"
                                : "border-danger bg-danger-soft text-danger")
                            }
                          >
                            {item.rules === "pass" ? "pass" : "fail"}
                          </span>
                        </td>
                        <td className="py-3 pr-4 font-mono text-[11px] text-ink-subtle">
                          {item.semantics}
                        </td>
                        <td className="py-3 pr-4 font-mono text-[11px] font-semibold text-danger">
                          {item.verdict}
                        </td>
                        <td className="py-3 text-ink-subtle">{item.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="border-2 border-rule-strong bg-paper-3 p-5 shadow-[var(--shadow-card)] sm:p-6">
              <h2 className="font-display text-xl font-bold">评测发现并修复的缺陷</h2>
              <ul className="mt-4 list-none space-y-3">
                {EVAL_FIXED_DEFECTS.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-6 text-ink-subtle">
                    <span aria-hidden="true" className="mt-2 block h-2 w-2 shrink-0 bg-accent" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-2 border-update bg-update-soft p-5 shadow-[var(--shadow-card)] sm:p-6">
              <h2 className="font-display text-xl font-bold">已知限制（未通过项照实记录）</h2>
              <ul className="mt-4 list-none space-y-3">
                {EVAL_KNOWN_LIMITS.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-6 text-ink-subtle">
                    <span aria-hidden="true" className="mt-2 block h-2 w-2 shrink-0 bg-update" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="mt-6 border border-rule bg-paper-2 p-5">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              复现命令
            </h2>
            <ul className="mt-3 space-y-2">
              {EVAL_REPRODUCE_COMMANDS.map((command) => (
                <li key={command}>
                  <code className="block break-all font-mono text-[11px] leading-5 text-ink-subtle">
                    {command}
                  </code>
                </li>
              ))}
            </ul>
          </section>

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-11 items-center border-2 border-accent bg-accent px-5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              重新加载本机报告
            </button>
            <p className="text-sm text-muted">
              {error ??
                "本实例没有本地评测记录（评测运行写在开发机本地），以上是随版本归档的真实结果。"}
            </p>
          </div>
        </div>
      </main>
    );
  }

  const qualityTotal = Math.max(1, summary.executed);
  const comparison = dashboard.comparison;

  return (
    <main className="min-h-screen bg-paper pb-20 text-ink">
      <header className="relative overflow-hidden border-b-2 border-rule-strong bg-paper bg-halftone">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-[6%] top-5 hidden h-28 w-28 halftone-patch lg:block"
        />
        <div className="relative z-10 mx-auto w-full max-w-[1120px] px-5 py-10 sm:px-8 sm:py-12">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
            ZHIHU THREADS · GOLDEN EVAL
          </p>
          <h1 className="mt-4 font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
            真实工作流
            <br />
            <span className="relative inline-block">
              <span className="relative z-10">评测看板</span>
              <span
                aria-hidden="true"
                className="absolute bottom-1 left-0 right-0 h-3 bg-accent/15"
              />
            </span>
          </h1>
          <p className="mt-5 max-w-[68ch] text-base leading-7 text-ink-subtle">
            查看真实 trace、工具调用、失败原因和场景成功率。每个指标都来自本地
            <span className="font-mono"> .local/evals </span>
            报告，不用于展示虚构分数。
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
            <RunSelect runs={dashboard.runs} value={selectedRunId} onChange={selectRun} />
            <Link
              to="/"
              className="inline-flex h-11 shrink-0 items-center border-2 border-rule-strong bg-paper-3 px-4 text-sm font-medium text-ink transition-colors duration-150 hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              返回学习入口
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1120px] space-y-10 px-5 py-10 sm:px-8">
        <section aria-labelledby="run-summary-heading">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <PanelHeader
              eyebrow="RUN SUMMARY"
              title="这次运行的质量概览"
              description={`${summary.executed}/${summary.total} 条已执行 · ${summary.model} · ${summary.commit.slice(0, 8)}`}
            />
            {loading && (
              <span aria-live="polite" className="font-mono text-xs text-muted">
                正在加载…
              </span>
            )}
          </div>
          <h2 id="run-summary-heading" className="sr-only">
            运行质量概览
          </h2>

          <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="执行率"
              value={toPercent(summary.executed / summary.total)}
              detail={`${summary.executed}/${summary.total}`}
            />
            <StatCard
              label="通过率"
              value={toPercent(summary.successRate)}
              detail={`${summary.passed} pass`}
            />
            <StatCard label="偏弱" value={String(summary.weak)} detail="有小缺陷但不失败" />
            <StatCard
              label="失败"
              value={String(summary.failed)}
              detail={`${summary.weak + summary.failed} 个非通过`}
            />
          </div>

          <div className="mt-4 border border-rule bg-paper-3 p-5 shadow-[var(--shadow-card)]">
            <ResultDonut
              passed={summary.passed}
              weak={summary.weak}
              failed={summary.failed}
              successRate={summary.successRate}
            />
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] text-muted">
              <span>PASS {summary.passed}</span>
              <span>WEAK {summary.weak}</span>
              <span>FAIL {summary.failed}</span>
              <span>DATASET v{summary.datasetVersion}</span>
              <span className="truncate">{summary.datasetHash.slice(0, 12)}</span>
            </div>
          </div>

          {comparison && (
            <div className="mt-4 grid gap-4 border border-accent bg-accent-soft p-4 lg:grid-cols-2">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
                  BASELINE DELTA
                </p>
                <p className="mt-2 text-sm leading-6 text-ink">
                  通过率变化：{comparison.successRateDelta >= 0 ? "+" : ""}
                  {toPercent(comparison.successRateDelta)}
                </p>
                <p className="text-sm leading-6 text-ink">
                  Judge 分数变化：{comparison.judgeScoreDelta >= 0 ? "+" : ""}
                  {comparison.judgeScoreDelta.toFixed(2)}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">回归 {comparison.regressions.length}</p>
                <p className="truncate font-mono text-[11px] text-muted">
                  {comparison.regressions.join(", ") || "无"}
                </p>
                <p className="mt-2 text-sm font-medium text-ink">
                  改进 {comparison.improvements.length}
                </p>
                <p className="truncate font-mono text-[11px] text-muted">
                  {comparison.improvements.join(", ") || "无"}
                </p>
              </div>
            </div>
          )}
        </section>

        <section aria-labelledby="trend-heading">
          <PanelHeader
            eyebrow="TREND"
            title="历史通过率趋势"
            description="按报告结束时间从左到右排列，圆点悬停可看 run ID。"
          />
          <h2 id="trend-heading" className="sr-only">
            历史通过率趋势
          </h2>
          <div className="mt-6 border border-rule bg-paper-3 p-5 shadow-[var(--shadow-card)]">
            <TrendChart runs={dashboard.runs} />
            <p className="mt-3 font-mono text-[11px] text-muted">
              {qualityTotal} 条本轮样本 · {dashboard.runs.length} 次真实报告
            </p>
          </div>
        </section>

        <section aria-labelledby="coverage-heading">
          <PanelHeader
            eyebrow="COVERAGE"
            title="场景与难度覆盖"
            description="浅灰是 dataset 总量，蓝色是已执行并通过的部分。"
          />
          <h2 id="coverage-heading" className="sr-only">
            覆盖率
          </h2>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <StackedQualityChart
              title="场景质量"
              rows={Object.entries(summary.byCategory).map(([key, value]) => ({
                key,
                label: CATEGORY_LABELS[key] ?? key,
                passed: value.passed,
                weak: Math.max(0, value.executed - value.passed),
                failed: 0,
              }))}
            />
            <div className="space-y-4 border border-rule bg-paper-3 p-5 shadow-[var(--shadow-card)]">
              <h3 className="text-sm font-semibold text-ink">难度</h3>
              {Object.entries(summary.byDifficulty).map(([key, value]) => (
                <CoverageRow
                  key={key}
                  label={DIFFICULTY_LABELS[key] ?? key}
                  executed={value.executed}
                  passed={value.passed}
                  total={value.total}
                />
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="metrics-heading">
          <PanelHeader eyebrow="QUALITY METRICS" title="关键质量指标" />
          <h2 id="metrics-heading" className="sr-only">
            关键质量指标
          </h2>
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(summary.metrics).map(([key, value]) => (
              <div key={key} className="border border-rule bg-paper-3 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium text-ink">
                    {METRIC_LABELS[key] ?? key}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted">{toPercent(value)}</span>
                </div>
                <div className="mt-2 h-2 w-full bg-rule">
                  <div
                    aria-hidden="true"
                    className={`h-full ${key === "judgeScore" || key === "similarity" ? "bg-info" : "bg-success"}`}
                    style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="failures-heading">
          <PanelHeader eyebrow="FAILURE MAP" title="失败信号分布" />
          <h2 id="failures-heading" className="sr-only">
            失败信号分布
          </h2>
          <div className="mt-6 border border-rule bg-paper-3 p-5 shadow-[var(--shadow-card)]">
            {Object.entries(summary.errors).length === 0 ? (
              <p className="text-sm text-ink-subtle">这轮抽样没有失败信号。</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(summary.errors)
                  .sort((left, right) => right[1] - left[1])
                  .map(([key, count]) => (
                    <div
                      key={key}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                    >
                      <span className="min-w-0 truncate font-mono text-[11px] text-ink-subtle">
                        {key}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-danger">{count}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </section>

        <section aria-labelledby="cases-heading">
          <PanelHeader
            eyebrow="CASE TRACES"
            title="Case 与 Trace"
            description="选择一条 case 查看工具顺序、输入输出和失败点。"
          />
          <h2 id="cases-heading" className="sr-only">
            Case 与 Trace
          </h2>

          <div className="mt-6 grid gap-3 border border-rule bg-paper-2 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-[0.10em] text-muted">
                状态
              </span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="mt-1 h-11 w-full border border-rule-strong bg-paper-3 px-3 text-sm focus:border-accent focus:outline-none"
              >
                <option value="all">全部</option>
                <option value="pass">通过</option>
                <option value="weak">偏弱</option>
                <option value="fail">失败</option>
              </select>
            </label>
            <label className="min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-[0.10em] text-muted">
                场景
              </span>
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                className="mt-1 h-11 w-full border border-rule-strong bg-paper-3 px-3 text-sm focus:border-accent focus:outline-none"
              >
                <option value="all">全部</option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_LABELS[category] ?? category}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-[0.10em] text-muted">
                难度
              </span>
              <select
                value={difficultyFilter}
                onChange={(event) => setDifficultyFilter(event.target.value)}
                className="mt-1 h-11 w-full border border-rule-strong bg-paper-3 px-3 text-sm focus:border-accent focus:outline-none"
              >
                <option value="all">全部</option>
                {difficulties.map((difficulty) => (
                  <option key={difficulty} value={difficulty}>
                    {DIFFICULTY_LABELS[difficulty] ?? difficulty}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-[0.10em] text-muted">
                搜索
              </span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="case ID / thread ID / failure"
                className="mt-1 h-11 w-full border border-rule-strong bg-paper-3 px-3 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-5 grid gap-3">
            {filteredCases.length === 0 ? (
              <p className="border border-rule bg-paper-3 p-5 text-sm text-ink-subtle">
                当前筛选没有匹配 case。
              </p>
            ) : (
              filteredCases.map((item) => {
                const selected = item.caseId === dashboard.selectedCaseId;
                return (
                  <button
                    key={item.caseId}
                    type="button"
                    onClick={() => selectCase(item.caseId)}
                    aria-pressed={selected}
                    className={`block w-full border bg-paper-3 px-4 py-4 text-left shadow-[var(--shadow-card)] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      selected ? "border-accent" : "border-rule-strong hover:border-accent"
                    }`}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <StatusChip status={item.status} />
                      <span className="min-w-0 truncate font-mono text-xs font-semibold text-ink">
                        {item.caseId}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                        {CATEGORY_LABELS[item.category] ?? item.category} ·{" "}
                        {DIFFICULTY_LABELS[item.difficulty] ?? item.difficulty}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                        {formatDuration(item.durationMs)}
                      </span>
                    </div>
                    {item.failures.length > 0 && (
                      <p className="mt-2 truncate font-mono text-[11px] text-danger">
                        {item.failures.join(" · ")}
                      </p>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </section>

        {dashboard.selectedCase && (
          <section aria-labelledby="trace-heading">
            <PanelHeader
              eyebrow="TRACE INSPECTOR"
              title={dashboard.selectedCase.caseId}
              description={`耗时 ${formatDuration(dashboard.selectedCase.durationMs)}${
                dashboard.selectedCase.threadId
                  ? ` · thread ${dashboard.selectedCase.threadId}`
                  : ""
              }`}
            />
            <h2 id="trace-heading" className="sr-only">
              Trace Inspector
            </h2>

            <div className="mt-6 border-2 border-rule-strong bg-paper-3 shadow-[var(--shadow-panel)]">
              <div className="border-b border-rule p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={dashboard.selectedCase.status} />
                  <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                    {CATEGORY_LABELS[dashboard.selectedCase.category] ??
                      dashboard.selectedCase.category}
                  </span>
                  {dashboard.selectedCase.bugId && (
                    <span className="font-mono text-[10px] text-muted">
                      {dashboard.selectedCase.bugId}
                    </span>
                  )}
                </div>
                {dashboard.selectedCase.failures.length > 0 ? (
                  <ul className="mt-3 list-none space-y-1">
                    {dashboard.selectedCase.failures.map((failure) => (
                      <li key={failure} className="font-mono text-[11px] text-danger">
                        {failure}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-success">没有失败信号。</p>
                )}
                {dashboard.selectedCase.threadId?.match(/^[0-9a-f]{16}$/) && (
                  <Link
                    to="/thread/$threadId"
                    params={{ threadId: dashboard.selectedCase.threadId }}
                    className="mt-4 inline-flex min-h-9 items-center border border-accent bg-accent-soft px-3 text-xs font-semibold text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    打开学习线程 →
                  </Link>
                )}
              </div>

              {dashboard.selectedCase.judge && (
                <div className="border-b border-rule bg-paper-2 p-5">
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                    LLM JUDGE
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StatusChip status={dashboard.selectedCase.judge.verdict} />
                    <span className="font-mono text-xs text-muted">
                      score {dashboard.selectedCase.judge.score.toFixed(2)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-ink-subtle">
                    {dashboard.selectedCase.judge.reason}
                  </p>
                </div>
              )}

              <div className="border-b border-rule p-5">
                <TracePre value={dashboard.selectedCase.modelOutput} label="MODEL OUTPUT" />
              </div>

              <ol className="list-none space-y-4 p-5">
                {dashboard.selectedCase.tools.map((tool, index) => (
                  <li
                    key={`${tool.tool}-${index}`}
                    className="border-l-2 border-accent bg-paper-2 px-4 py-4"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-[10px] text-muted">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="font-mono text-xs font-semibold text-ink">{tool.tool}</span>
                      <span className="ml-auto font-mono text-[11px] text-muted">
                        {formatDuration(tool.durationMs)}
                      </span>
                    </div>
                    {tool.error && (
                      <p className="mt-2 font-mono text-[11px] text-danger">{tool.error}</p>
                    )}
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <TracePre value={tool.input} label="INPUT" />
                      <TracePre value={tool.output} label="OUTPUT" />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
