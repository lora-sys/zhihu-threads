import { createHash } from "node:crypto";
import type { Attempt, CaseResult, Execution, Judge, Port, RunReport, Runtime, Task } from "./types.ts";
import { execute, validArtifact, validSource } from "./execution.ts";
import { grade } from "./grading.ts";
import { bounded, createLedger, deadline, errorCode, EvalError, integer, phaseTotals, totals } from "./runtime.ts";
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) :
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const tools = new Set(["clarify", "search", "rank", "generate", "read", "ask"]);
export const validateTask = (task: Task): void => {
  if (!task || !/^[a-zA-Z0-9_-]+$/.test(task.id) || typeof task.title !== "string" || !task.title.trim())
    throw new EvalError("INVALID_TASK");
  if (!["capability", "regression"].includes(task.purpose) || !["single_step", "workflow", "multi_turn", "autonomous"].includes(task.mode))
    throw new EvalError("INVALID_TASK_KIND");
  const input = task.input;
  if (!input || typeof input.question !== "string" || input.question.length > 100000)
    throw new EvalError("INVALID_TASK_INPUT");
  if (input.followUps !== undefined && (!strings(input.followUps) || input.followUps.length > 20))
    throw new EvalError("INVALID_FOLLOWUPS");
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length > 100 || !input.sources.every(validSource)))
    throw new EvalError("INVALID_SOURCE_SETUP");
  if (input.artifact !== undefined && !validArtifact(input.artifact))
    throw new EvalError("INVALID_ARTIFACT_SETUP");
  if (input.selectedSourceIds !== undefined && !strings(input.selectedSourceIds))
    throw new EvalError("INVALID_SELECTED_IDS");
  if (task.mode === "single_step" && !input.step)
    throw new EvalError("SINGLE_STEP_REQUIRED");
  if (task.mode === "multi_turn" && !input.followUps?.length)
    throw new EvalError("FOLLOWUPS_REQUIRED");
  const expected = task.expected;
  if (!expected || !strings(expected.outcomes) || !expected.outcomes.length || expected.outcomes.some((x) => !["completed", "refused", "evidence_gap", "error", "budget_exceeded"].includes(x)))
    throw new EvalError("INVALID_EXPECTED_OUTCOMES");
  if (expected.minSources !== undefined)
    integer(expected.minSources, 0, 0, 100);
  if (expected.concepts !== undefined && (!Array.isArray(expected.concepts) || expected.concepts.some((group) => !strings(group) || !group.length || group.some((x) => !x.trim()))))
    throw new EvalError("INVALID_CONCEPTS");
  for (const value of [expected.requiredTools, expected.forbiddenTools])
    if (value !== undefined && (!strings(value) || value.some((x) => !tools.has(x))))
      throw new EvalError("INVALID_EXPECTED_TOOLS");
  for (const value of [expected.forbiddenText, expected.allowedErrorCodes])
    if (value !== undefined && (!strings(value) || value.some((x) => !x.trim())))
      throw new EvalError("INVALID_EXPECTED_TEXT");
  for (const value of [expected.synthesis, expected.citations, expected.supplement])
    if (value !== undefined && typeof value !== "boolean")
      throw new EvalError("INVALID_EXPECTED_FLAG");
  if (expected.answerability !== undefined && (!strings(expected.answerability) || expected.answerability.length !== input.followUps?.length || expected.answerability.some((x) => !["answerable", "insufficient", "unsafe", "unknown"].includes(x))))
    throw new EvalError("INVALID_ANSWERABILITY");
  if (task.purpose === "regression" && (!task.regression?.contract?.trim() || !strings(task.regression.affectedPaths) || !task.regression.affectedPaths.length || task.regression.affectedPaths.some((path) => !path.trim())))
    throw new EvalError("REGRESSION_CONTRACT_REQUIRED");
};
export interface Options {
  createPort: (runtime: Runtime, attempt: number) => Promise<Port>;
  judge?: Judge;
  maxAttempts?: number;
  maxCalls?: number;
  maxSteps?: number;
  executionTimeoutMs?: number;
  judgeTimeoutMs?: number;
  secrets?: string[];
}
export const runCase = async (task: Task, options: Options): Promise<CaseResult> => {
  validateTask(task);
  const maxAttempts = integer(options.maxAttempts, 2, 1, 5);
  const maxSteps = integer(options.maxSteps, 16, 1, 100);
  const maxCalls = integer(options.maxCalls, 40, 1, 1000);
  const executionTimeoutMs = integer(options.executionTimeoutMs, 180000);
  const judgeTimeoutMs = integer(options.judgeTimeoutMs, 30000);
  const began = performance.now();
  const attempts: Attempt[] = [];
  for (let number = 1; number <= maxAttempts; number++) {
    const start = performance.now();
    const ledger = createLedger(maxCalls);
    const executionDeadline = deadline(executionTimeoutMs);
    const runtime = ledger.runtime(executionDeadline.signal);
    let port: Port | undefined;
    let execution: Execution;
    try {
      port = await bounded(options.createPort(runtime, number), runtime.signal);
      execution = await execute(task.input, task.mode, port, runtime, maxSteps);
    }
    catch (error) {
      const code = errorCode(error, "PORT_SETUP_FAILED");
      execution = { outcome: /BUDGET|DEADLINE/.test(code) ? "budget_exceeded" : "error", steps: [], turns: [], sources: [], error: { code, retryable: false }, durationMs: performance.now() - start };
    }
    finally {
      executionDeadline.clear();
    }
    if (ledger.denied()) {
      execution.outcome = "budget_exceeded";
      execution.error = { code: "CALL_BUDGET_EXCEEDED", retryable: false };
    }
    const executionMs = performance.now() - start;
    const gradeStart = performance.now();
    const gradeDeadline = deadline(judgeTimeoutMs);
    let graded;
    try {
      graded = await grade(task, execution, options.judge, ledger.runtime(gradeDeadline.signal), options.secrets);
    }
    finally {
      gradeDeadline.clear();
    }
    const gradingMs = performance.now() - gradeStart;
    const cleanupDeadline = deadline(2000);
    try {
      if (port?.dispose)
        await bounded(port.dispose(), cleanupDeadline.signal);
    }
    catch {
      execution.error = { code: "CLEANUP_FAILED", retryable: false };
      execution.outcome = "error";
      graded.checks.push({ id: "cleanup", pass: false, detail: "Attempt state was not released" });
      graded.rules = "fail";
      graded.verdict = "fail";
    }
    finally {
      cleanupDeadline.clear();
    }
    const calls = ledger.close();
    attempts.push({ number, execution, grade: graded, calls, totals: totals(calls), executionMs, gradingMs, wallMs: performance.now() - start });
    // Retry according to observed transient errors, never according to expected labels or scores.
    if (!execution.error?.retryable)
      break;
  }
  const first = attempts[0];
  const final = attempts.at(-1)!;
  return { id: task.id, task: structuredClone(task), purpose: task.purpose, mode: task.mode, taskHash: hash(task), attempts,
    firstAttemptSuccess: first.grade.verdict === "pass",
    retrySuccess: first.grade.verdict !== "pass" && attempts.slice(1).some((attempt) => attempt.grade.verdict === "pass"),
    firstAttemptRulesPass: first.grade.rules === "pass",
    retryRulesPass: first.grade.rules !== "pass" && attempts.slice(1).some((attempt) => attempt.grade.rules === "pass"),
    finalVerdict: final.grade.verdict, totals: totals(attempts.flatMap((attempt) => attempt.calls)), wallMs: performance.now() - began };
};
export const makeReport = (input: Omit<RunReport, "schemaVersion" | "totals" | "totalsByPhase">): RunReport => {
  const calls = input.cases.flatMap((item) => item.attempts.flatMap((attempt) => attempt.calls));
  return { ...input, schemaVersion: 3, totals: totals(calls), totalsByPhase: phaseTotals(calls) };
};
export const selectTasks = (tasks: Task[], options: {
  ids?: string[];
  purpose?: string;
  mode?: string;
  changedFiles?: string[];
  offset?: number;
  limit?: number;
} = {}): Task[] => {
  tasks.forEach(validateTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new EvalError("DUPLICATE_TASK_ID");
  if (options.ids?.some((id) => !tasks.some((task) => task.id === id)))
    throw new EvalError("UNKNOWN_TASK_ID");
  const offset = integer(options.offset, 0, 0);
  const limit = integer(options.limit, Math.max(1, tasks.length));
  return tasks.filter((task) => !options.ids || options.ids.includes(task.id))
    .filter((task) => !options.purpose || task.purpose === options.purpose)
    .filter((task) => !options.mode || task.mode === options.mode)
    .filter((task) => !options.changedFiles?.length || task.purpose === "regression" && task.regression!.affectedPaths.some((path) => options.changedFiles!.some((file) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`))))
    .slice(offset, offset + limit);
};
export const compare = (before: RunReport, after: RunReport) => {
  const reasons: string[] = [];
  if (before.schemaVersion !== 3 || after.schemaVersion !== 3)
    reasons.push("schema_version");
  if (!before.complete || !after.complete)
    reasons.push("incomplete_run");
  if (hash(before.measurement) !== hash(after.measurement))
    reasons.push("measurement_configuration");
  if (before.subject.profile !== after.subject.profile)
    reasons.push("execution_profile");
  if ([...before.cases, ...after.cases].some((c) => !c.task || hash(c.task) !== c.taskHash))
    reasons.push("task_hash_integrity");
  const identities = (report: RunReport) => report.cases.map((c) => [c.id, c.taskHash]).sort(([a], [b]) => a.localeCompare(b));
  if (hash(identities(before)) !== hash(identities(after)))
    reasons.push("case_content_or_selection");
  if (reasons.length)
    return { comparable: false, reasons, regressions: [], recoveries: [], semanticRegressions: [], unjudgedAfter: [] };
  const old = new Map(before.cases.map((c) => [c.id, c]));
  return {
    comparable: true, reasons,
    interpretation: after.measurement.sourceMode === "fixed" ? "controlled-input comparison" : "observational only: live retrieval can change",
    regressions: after.cases.filter((c) => c.purpose === "regression" && old.get(c.id)!.firstAttemptRulesPass && !c.firstAttemptRulesPass).map((c) => c.id),
    recoveries: after.cases.filter((c) => c.purpose === "regression" && !old.get(c.id)!.firstAttemptRulesPass && c.firstAttemptRulesPass).map((c) => c.id),
    semanticRegressions: after.cases.filter((c) => old.get(c.id)!.firstAttemptSuccess && c.attempts[0].grade.verdict === "fail").map((c) => c.id),
    unjudgedAfter: after.cases.filter((c) => c.attempts[0].grade.verdict === "unjudged").map((c) => c.id),
  };
};
const cell = (value: unknown) => String(value ?? "unknown").replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
export const markdown = (report: RunReport): string => {
  const lines = ["# Eval v3 report", "", `Run ${report.runId}. Complete ${report.complete}. Profile ${report.subject.profile}.`,
    "Rules pass does not imply assessed semantic quality. Synthetic fixtures do not measure live model capability.", "",
    "| Case | Purpose | First success | Retry success | First rules | Retry rules | Final | Calls | Wall ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const c of report.cases)
    lines.push(`| ${[c.id, c.purpose, c.firstAttemptSuccess, c.retrySuccess, c.firstAttemptRulesPass, c.retryRulesPass, c.finalVerdict, c.totals.calls, c.wallMs.toFixed(2)].map(cell).join(" | ")} |`);
  for (const purpose of ["capability", "regression"] as const) {
    const cases = report.cases.filter((c) => c.purpose === purpose);
    lines.push("", `## ${purpose}`, `${cases.length} cases; ${cases.filter((c) => c.firstAttemptSuccess).length} first semantic successes; ${cases.filter((c) => c.retrySuccess).length} recovered semantic successes; ${cases.filter((c) => c.firstAttemptRulesPass).length} first rule passes.`);
  }
  lines.push("", "## All attempts");
  for (const c of report.cases)
    for (const a of c.attempts)
      lines.push("", `### ${c.id} attempt ${a.number}`, `Rules ${a.grade.rules}. Semantics ${a.grade.semantics}. Verdict ${a.grade.verdict}.`, `Execution ${a.executionMs.toFixed(2)} ms. Grading ${a.gradingMs.toFixed(2)} ms. Wall ${a.wallMs.toFixed(2)} ms.`, `Usage ${JSON.stringify(a.totals)}`, `Quality ${JSON.stringify(a.grade.metrics)}`, ...a.grade.checks.filter((check) => !check.pass).map((check) => `Failed ${cell(check.id)}. ${cell(check.detail)}`));
  lines.push("", "## Total usage", JSON.stringify(report.totals), "", "## By phase", JSON.stringify(report.totalsByPhase), "", "Null tokens/cost mean unknown. Known subtotals are not a total bill. Provider durations are summed work, not wall latency.");
  return lines.join("\n") + "\n";
};
export const redact = <T>(value: T, secrets: string[]): T => {
  const visit = (v: unknown): unknown => typeof v === "string" ? secrets.filter(Boolean).sort((a, b) => b.length - a.length).reduce((s, secret) => s.split(secret).join("[REDACTED]"), v)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]") : Array.isArray(v) ? v.map(visit) :
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(authorization|api_?key|access_?secret|app_?key)$/i.test(k) ? "[REDACTED]" : visit(x)])) : v;
  return visit(value) as T;
};
