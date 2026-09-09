import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Export one already-authorized report to a fixed-evidence generation task. No network.
const [reportPath, caseId, outputPath] = process.argv.slice(2);
if (!reportPath || !caseId || !outputPath)
  throw new Error(
    "Usage: node scripts/eval-extract-fixed.mjs REPORT CASE_ID .local/evals/fixtures/task.json",
  );
const out = resolve(outputPath);
if (!out.startsWith(resolve(".local/evals/fixtures") + "/") || !out.endsWith(".json"))
  throw new Error("Output must be under .local/evals/fixtures and end in .json");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (report.schemaVersion !== 3 || report.complete !== true || report.subject?.profile !== "product")
  throw new Error("A complete v3 product report is required");
const item = report.cases.find((entry) => entry.id === caseId);
const attempt = item?.attempts.at(-1);
const sources = attempt?.execution.artifact?.sources;
if (
  !item?.task ||
  !Array.isArray(sources) ||
  sources.length === 0 ||
  sources.some(
    (source) =>
      !["Answer", "Article"].includes(source.kind) ||
      source.capturedAt === undefined ||
      source.editTime === undefined ||
      !source.contentId,
  )
)
  throw new Error("No reusable complete evidence snapshot in this case");
const task = {
  id: `${caseId}-fixed-generate`,
  title: `${item.task.title} 固定材料生成`,
  purpose: "capability",
  mode: "single_step",
  input: {
    question: item.task.input.question,
    learningTask: item.task.input.learningTask,
    sources,
    step: { tool: "generate", sourceIds: sources.map((source) => source.id) },
  },
  expected: {
    outcomes: ["completed"],
    minSources: sources.length,
    synthesis: true,
    citations: true,
  },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify([task], null, 2), { flag: "wx" });
console.log(
  `Created ${out}. Review learning goals and expected concepts manually before using as a baseline.`,
);
