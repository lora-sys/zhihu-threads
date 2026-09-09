import { mkdirSync, writeFileSync } from "node:fs";
import { contracts } from "./contracts.ts";
import { scenarios, fixturePort } from "./fixtures.ts";
import { hash, makeReport, markdown, runCase } from "./runner.ts";
import { SCORER } from "./grading.ts";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("OFFLINE_DRIVER_NETWORK_DENIED");
};
const began = performance.now();
const checks: Array<{
  id: string;
  name: string;
  passed: boolean;
  affectedPaths: string[];
  durationMs: number;
  error?: string;
}> = [];
try {
  for (const item of contracts) {
    const start = performance.now();
    try {
      await item.run();
      checks.push({
        id: item.id,
        name: item.name,
        passed: true,
        affectedPaths: item.affectedPaths,
        durationMs: performance.now() - start,
      });
    } catch (error) {
      checks.push({
        id: item.id,
        name: item.name,
        passed: false,
        affectedPaths: item.affectedPaths,
        durationMs: performance.now() - start,
        error: error instanceof Error ? error.message : "Contract failure",
      });
    }
  }
  const tasks = scenarios();
  const cases = [];
  for (const task of tasks)
    cases.push(await runCase(task, { createPort: async () => fixturePort() }));
  const report = makeReport({
    complete: true,
    runId: "offline-fixtures",
    subject: { commit: "delivery-working-tree", model: "none", profile: "fixture" },
    measurement: {
      scorer: SCORER,
      datasetHash: hash(tasks),
      caseSetHash: hash(tasks.map((t) => t.id)),
      fixtureHash: hash(tasks.map((t) => t.input)),
      judge: "none",
      policy: "scripted-fixture-v1",
      budgets: "defaults",
      sourceMode: "fixed",
    },
    cases,
    wallMs: performance.now() - began,
  });
  const path = ".local/evals/v3/offline";
  mkdirSync(path, { recursive: true });
  writeFileSync(
    `${path}/contracts.json`,
    JSON.stringify(
      { passed: checks.filter((x) => x.passed).length, total: checks.length, checks },
      null,
      2,
    ),
  );
  writeFileSync(`${path}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${path}/report.md`, markdown(report));
  console.log(
    JSON.stringify(
      {
        contractTests: `${checks.filter((x) => x.passed).length}/${checks.length}`,
        scenarios: cases.length,
        rulesPassed: cases.filter((x) => x.firstAttemptRulesPass).length,
        semanticSuccesses: cases.filter((x) => x.firstAttemptSuccess).length,
        actualModelCalls: 0,
        actualZhihuCalls: 0,
        report: `${path}/report.md`,
      },
      null,
      2,
    ),
  );
  for (const check of checks.filter((x) => !x.passed)) console.error(check.name, check.error);
  if (checks.some((x) => !x.passed) || cases.some((x) => !x.firstAttemptRulesPass))
    process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}
