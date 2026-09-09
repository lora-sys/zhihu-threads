import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Mode, RunReport, Task } from "./types.ts";
import { adaptLegacy } from "./legacy.ts";
import { compare, hash, makeReport, markdown, redact, runCase, selectTasks } from "./runner.ts";
import { SCORER } from "./grading.ts";
import { EvalError, integer } from "./runtime.ts";
import { installNetwork } from "./network.ts";
import { makeJudge, POLICY_VERSION, JUDGE_VERSION } from "./policy.ts";
import { completeFor, createProductPort } from "./product-runtime.ts";
const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");
const atomic = (path: string, text: string) => { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };
const load = () => {
  if (process.env.EVAL_TASK_FILE) {
    const path = resolve(process.env.EVAL_TASK_FILE);
    if (![resolve(".local/evals/fixtures") + "/", resolve("src/evals/datasets") + "/"].some(root => path.startsWith(root)) || !path.endsWith(".json"))
      throw new EvalError("TASK_PATH_DENIED");
    const raw = readFileSync(path, "utf8");
    const tasks: unknown = JSON.parse(raw);
    if (!Array.isArray(tasks))
      throw new EvalError("TASK_ARRAY_REQUIRED");
    return { tasks: tasks as Task[], datasetHash: sha256(raw) };
  }
  const name = process.env.EVAL_DATASET ?? "golden-v2.jsonl";
  if (!["golden-v1.jsonl", "golden-v2.jsonl"].includes(name))
    throw new EvalError("UNKNOWN_DATASET");
  const raw = readFileSync(`src/evals/datasets/${name}`, "utf8");
  const manifest = JSON.parse(readFileSync(`src/evals/datasets/${name === "golden-v2.jsonl" ? "manifest-v2.json" : "manifest.json"}`, "utf8")) as {
    sha256: string;
    cases: number;
  };
  let legacy = raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as Parameters<typeof adaptLegacy>[0]);
  if (sha256(raw) !== manifest.sha256 || legacy.length !== manifest.cases)
    throw new EvalError("DATASET_INTEGRITY_FAILED");
  if (process.env.EVAL_CATEGORY)
    legacy = legacy.filter(item => item.category === process.env.EVAL_CATEGORY);
  return { tasks: legacy.map(adaptLegacy), datasetHash: sha256(raw) };
};
/** All live calls require both the command opt-in and EVAL_LIVE=1. */
export const runLive = async (): Promise<RunReport> => {
  if (process.env.EVAL_LIVE !== "1")
    throw new EvalError("LIVE_DISABLED_USE_EVAL_OFFLINE");
  const model = process.env.OPENAI_MODEL;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const modelKey = process.env.OPENAI_API_KEY;
  const searchSecret = process.env.ZHIHU_ACCESS_SECRET;
  if (!model || !baseUrl || !modelKey || !searchSecret)
    throw new EvalError("LIVE_CONFIGURATION_REQUIRED");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new EvalError("INVALID_MODEL_URL");
  const loaded = load();
  let tasks = loaded.tasks;
  if (process.env.EVAL_FILTER)
    tasks = tasks.filter(task => task.id.includes(process.env.EVAL_FILTER!) || task.title.includes(process.env.EVAL_FILTER!));
  const mode = process.env.EVAL_MODE;
  if (mode) {
    if (!["single_step", "workflow", "multi_turn", "autonomous"].includes(mode))
      throw new EvalError("INVALID_MODE");
    tasks = tasks.map(task => ({ ...task, mode: mode as Mode }));
  }
  const stride = integer(process.env.EVAL_STRIDE, 0, 0);
  if (stride)
    tasks = tasks.filter((_, index) => index % stride === 0);
  tasks = selectTasks(tasks, { ids: process.env.EVAL_CASE_IDS?.split(","), purpose: process.env.EVAL_PURPOSE,
    changedFiles: process.env.EVAL_CHANGED_FILES?.split(","), offset: integer(process.env.EVAL_OFFSET, 0, 0), limit: integer(process.env.EVAL_LIMIT, 12, 1, 50) });
  if (!tasks.length)
    throw new EvalError("EMPTY_TASK_SELECTION");
  const concurrency = integer(process.env.EVAL_CONCURRENCY, 1, 1, 8);
  const options = { maxAttempts: integer(process.env.EVAL_MAX_ATTEMPTS, 2, 1, 5), maxCalls: integer(process.env.EVAL_MAX_CALLS, 40, 1, 1000),
    maxSteps: integer(process.env.EVAL_MAX_STEPS, 16, 1, 100), executionTimeoutMs: integer(process.env.EVAL_EXECUTION_TIMEOUT_MS, 180000), judgeTimeoutMs: integer(process.env.EVAL_JUDGE_TIMEOUT_MS, 30000) };
  const maxRunCalls = integer(process.env.EVAL_MAX_RUN_CALLS, 100, 1, 5000);
  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? model;
  const judgeEnabled = process.env.EVAL_JUDGE !== "false";
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const root = resolve(".local/evals/v3", runId);
  mkdirSync(root, { recursive: true });
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }
  catch { /* Explicit unknown outside Git checkout. */ }
  const began = performance.now();
  const cases: RunReport["cases"] = [];
  const codeHash = (file: string) => sha256(readFileSync(`src/evals/v3/${file}`, "utf8"));
  const measurement: RunReport["measurement"] = { scorer: `${SCORER}/${codeHash("grading.ts")}`, datasetHash: loaded.datasetHash,
    caseSetHash: hash(tasks.map(task => [task.id, hash(task)]).sort()), fixtureHash: hash(tasks.map(task => task.input)),
    judge: hash({ judgeEnabled, judgeModel, baseUrl, JUDGE_VERSION }), policy: hash({ POLICY_VERSION, execution: codeHash("execution.ts"), bridge: codeHash("bridge.ts"), runner: codeHash("runner.ts"), runtime: codeHash("runtime.ts") }),
    budgets: hash({ ...options, concurrency, maxRunCalls }), sourceMode: tasks.every(task => task.mode === "single_step" && task.input.step?.tool !== "search") ? "fixed" : "live" };
  const network = installNetwork({ live: true, origins: [url.origin, "https://developer.zhihu.com"], maxRunCalls });
  const config = { root, model, baseUrl, modelKey, searchSecret, network, judgeModel };
  const persist = (complete: boolean) => {
    const report = redact(makeReport({ complete, runId, subject: { commit, model, profile: "product" }, measurement,
      cases: [...cases].sort((a, b) => a.id.localeCompare(b.id)), wallMs: performance.now() - began }), [modelKey, searchSecret]);
    atomic(join(root, "report.json"), JSON.stringify(report, null, 2));
    atomic(join(root, "report.md"), markdown(report));
    return report;
  };
  try {
    persist(false);
    for (let offset = 0; offset < tasks.length; offset += concurrency) {
      if (network.exhausted())
        break;
      await Promise.all(tasks.slice(offset, offset + concurrency).map(async (task) => {
        const result = await runCase(task, { ...options, secrets: [modelKey, searchSecret], judge: judgeEnabled ? makeJudge(completeFor(config)) : undefined,
          createPort: async (_runtime, attempt) => createProductPort({ ...config, root: join(root, task.id, `attempt-${attempt}`) }) });
        cases.push(result);
        persist(false);
      }));
    }
    const report = persist(cases.length === tasks.length);
    if (process.env.EVAL_BASELINE) {
      const path = resolve(process.env.EVAL_BASELINE);
      if (!path.startsWith(resolve(".local/evals/v3") + "/") || !path.endsWith("report.json"))
        throw new EvalError("BASELINE_PATH_DENIED");
      const baseline = JSON.parse(readFileSync(path, "utf8")) as RunReport;
      atomic(join(root, "comparison.json"), JSON.stringify(compare(baseline, report), null, 2));
    }
    console.log(JSON.stringify({ runId, report: join(root, "report.md"), complete: report.complete, firstSuccess: cases.filter(c => c.firstAttemptSuccess).map(c => c.id),
      retrySuccess: cases.filter(c => c.retrySuccess).map(c => c.id), rulesOnly: cases.filter(c => c.finalVerdict === "unjudged").map(c => c.id), totals: report.totals }, null, 2));
    return report;
  }
  finally {
    try {
      persist(cases.length === tasks.length);
    }
    finally {
      network.restore();
    }
  }
};
