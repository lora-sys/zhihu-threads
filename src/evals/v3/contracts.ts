import { adaptLegacy } from "./legacy.ts";
import { bridgeContracts } from "./bridge-contracts.ts";
import assert from "node:assert/strict";
import { execute, parseAction } from "./execution.ts";
import { grade, rules, parseAssessment, unitsOf } from "./grading.ts";
import {
  compare,
  hash,
  makeReport,
  markdown,
  redact,
  runCase,
  selectTasks,
  validateTask,
} from "./runner.ts";
import { createLedger, fixtureUsage, totals } from "./runtime.ts";
import { installNetwork } from "./network.ts";
import { makePolicy } from "./policy.ts";
import { artifactOf, fixturePolicy, fixturePort, scenarios, SOURCES, taskOf } from "./fixtures.ts";
import type { Judge, Runtime } from "./types.ts";
export const contracts: Array<{
  id: string;
  name: string;
  affectedPaths: string[];
  run: () => Promise<void> | void;
}> = [];
const test = (name: string, run: () => Promise<void> | void, paths = ["src/evals/v3/"]) =>
  contracts.push({ id: `reg-contract-${contracts.length + 1}`, name, run, affectedPaths: paths });
const context = (): Runtime => createLedger(100).runtime(new AbortController().signal);
const exec = (task = taskOf()) => execute(task.input, task.mode, fixturePort(), context());
const judge: Judge = async (input, runtime) => {
  const finish = runtime.beginCall("judge", "model", "fixture");
  finish({ status: "ok", usage: fixtureUsage });
  return {
    taskComplete: true,
    reason: "Synthetic assessment for contract testing only",
    units: input.units.map((unit) => ({ id: unit.id, supported: true, relevant: true })),
  };
};
const measure = {
  scorer: "test-v3",
  datasetHash: "test",
  caseSetHash: "test",
  fixtureHash: "test",
  judge: "none",
  policy: "fixture",
  budgets: "test",
  sourceMode: "fixed" as const,
};
const reportFor = async (task = taskOf()) =>
  makeReport({
    complete: true,
    runId: "test",
    subject: { commit: "test", model: "none", profile: "fixture" },
    measurement: measure,
    cases: [await runCase(task, { createPort: async () => fixturePort() })],
    wallMs: 1,
  });
test("expected labels cannot alter actions or selection", async () => {
  const a = taskOf();
  const b = structuredClone(a);
  b.expected = { outcomes: ["refused"], minSources: 99 };
  const x = await exec(a);
  const y = await exec(b);
  assert.deepEqual(
    x.steps.map((s) => [s.action, s.observation]),
    y.steps.map((s) => [s.action, s.observation]),
  );
  assert.equal(rules(a, x).rules, "pass");
  assert.equal(rules(b, y).rules, "fail");
});
test("real product refusal stops before search", async () => {
  const task = scenarios().find((t) => t.id === "reg-product-refusal")!;
  const x = await exec(task);
  assert.equal(x.outcome, "refused");
  assert.deepEqual(
    x.steps.map((s) => s.action.tool),
    ["clarify"],
  );
  assert.equal(rules(task, x).rules, "pass");
});
test("long input is forwarded without evaluator truncation", async () => {
  const input = { question: "长".repeat(501) };
  let seen = "";
  await execute(
    input,
    "workflow",
    fixturePort({
      override: (_a, v) => {
        seen = v.input.question;
        return { status: "refused", message: "Too long" };
      },
    }),
    context(),
  );
  assert.equal(seen.length, 501);
});
test("blank input reaches the product boundary", async () => {
  let seen = false;
  await execute(
    { question: "" },
    "workflow",
    fixturePort({
      override: () => {
        seen = true;
        return { status: "error", code: "INVALID_REQUEST", retryable: false };
      },
    }),
    context(),
  );
  assert.equal(seen, true);
});
for (const task of scenarios().filter((t) => t.mode === "single_step"))
  test(
    `single-step ${task.input.step!.tool} invokes exactly one module`,
    async () => {
      const x = await exec(task);
      assert.equal(x.steps.length, 1);
      assert.equal(x.steps[0].action.tool, task.input.step!.tool);
      assert.equal(rules(task, x).rules, "pass");
    },
    task.regression!.affectedPaths,
  );
test("missing single-step setup is rejected", () => {
  const t = taskOf();
  t.mode = "single_step";
  assert.throws(() => validateTask(t));
});
test("every conversation turn captures independent evidence", async () => {
  const t = scenarios().find((t) => t.mode === "multi_turn")!;
  const x = await exec(t);
  x.sources[0].text = "changed later";
  assert.equal(x.turns.length, 3);
  assert.equal(x.turns[0].available[0].text, SOURCES[0].text);
});
test("earlier forbidden output cannot hide in the last clean turn", async () => {
  const t = scenarios().find((t) => t.mode === "multi_turn")!;
  t.expected.forbiddenText = ["attack-marker"];
  const x = await exec(t);
  x.turns[0].answer.text = "attack-marker";
  assert.equal(rules(t, x).rules, "fail");
});
test("semantic judge receives original goal and all questions", async () => {
  const t = scenarios().find((t) => t.mode === "multi_turn")!;
  await grade(
    t,
    await exec(t),
    async (input, runtime) => {
      assert.equal(input.learningTask, t.input.learningTask);
      assert.deepEqual(
        input.units.filter((u) => u.id.startsWith("turn:")).map((u) => u.question),
        t.input.followUps,
      );
      return judge(input, runtime);
    },
    context(),
  );
});
test("earlier unsupported answer fails the whole semantic grade", async () => {
  const t = scenarios().find((t) => t.mode === "multi_turn")!;
  const g = await grade(
    t,
    await exec(t),
    async (input) => ({
      taskComplete: true,
      reason: "fixture",
      units: input.units.map((u) => ({ id: u.id, supported: u.id !== "turn:0", relevant: true })),
    }),
    context(),
  );
  assert.equal(g.verdict, "fail");
  assert.equal(g.metrics.unsupportedUnits, 1);
});
test("later evidence cannot justify earlier quotes", async () => {
  const t = taskOf();
  const x = await exec(t);
  const ref = x.turns[0].answer.citations[0];
  ref.fingerprint = "future";
  ref.quote = "later fact";
  x.sources.push({ ...SOURCES[0], fingerprint: "future", text: "later fact" });
  assert.equal(rules(t, x).metrics.quoteContainment, false);
});
test("requested turns must occur in order", async () => {
  const t = scenarios().find((t) => t.mode === "multi_turn")!;
  const x = await exec(t);
  x.turns.reverse();
  assert.equal(rules(t, x).checks.find((c) => c.id === "requested_turns")!.pass, false);
});
test("missing semantic judge leaves rule-clean result unjudged", async () => {
  const r = await runCase(taskOf(), { createPort: async () => fixturePort() });
  assert.equal(r.firstAttemptRulesPass, true);
  assert.equal(r.firstAttemptSuccess, false);
  assert.equal(r.finalVerdict, "unjudged");
});
test("judge failure cannot become a success", async () => {
  const g = await grade(
    taskOf(),
    await exec(),
    async () => {
      throw Error("offline");
    },
    context(),
  );
  assert.equal(g.semantics, "unavailable");
  assert.equal(g.verdict, "unjudged");
});
test("judge missing units is invalid", async () => {
  const g = await grade(
    taskOf(),
    await exec(),
    async () => ({ taskComplete: true, reason: "fixture", units: [] }),
    context(),
  );
  assert.equal(g.semantics, "invalid");
  assert.equal(g.verdict, "unjudged");
});
test("duplicate semantic ids are invalid", async () => {
  const units = unitsOf(await exec());
  assert.equal(
    parseAssessment(
      {
        taskComplete: true,
        reason: "fixture",
        units: units.map(() => ({ id: units[0].id, supported: true, relevant: true })),
      },
      units,
    ),
    undefined,
  );
});
test("unknown semantic support is not zero fabrication", async () => {
  const g = await grade(
    taskOf(),
    await exec(),
    async (input) => ({
      taskComplete: true,
      reason: "unknown",
      units: input.units.map((u) => ({ id: u.id, supported: null, relevant: true })),
    }),
    context(),
  );
  assert.equal(g.verdict, "unjudged");
  assert.equal(g.metrics.unsupportedRate, null);
});
test("quote exists but belongs to another source", async () => {
  const x = await exec();
  Object.assign(x.turns[0].answer.citations[0], { sourceId: "b", url: SOURCES[1].url });
  const g = rules(taskOf(), x);
  assert.equal(g.metrics.quoteContainment, true);
  assert.equal(g.metrics.sourceBinding, false);
});
for (const field of ["url", "author"] as const)
  test(`wrong ${field} fails source binding`, async () => {
    const x = await exec();
    x.turns[0].answer.citations[0][field] = "wrong";
    assert.equal(rules(taskOf(), x).metrics.sourceBinding, false);
  });
test("an undisplayed author is not counted as verified", async () => {
  const x = await exec();
  for (const step of x.steps)
    for (const unit of step.observation.artifact?.units ?? [])
      for (const ref of unit.citations) delete ref.author;
  const g = rules(taskOf(), x);
  assert.equal(g.metrics.authorChecks, 0);
  assert.equal(g.metrics.sourceBinding, true);
});
test("fabricated quotations fail exact containment", async () => {
  const x = await exec();
  x.turns[0].answer.citations[0].quote = "not in excerpt";
  assert.equal(rules(taskOf(), x).metrics.quoteContainment, false);
});
test("a model cannot forge its own evidence source", async () => {
  const x = await exec();
  const step = x.steps.find((s) => s.action.tool === "generate")!;
  step.observation.artifact!.sources[0].text = "forged";
  assert.equal(
    rules(taskOf(), x).checks.some((c) => c.id.startsWith("source_snapshot:") && !c.pass),
    true,
  );
});
test("read-back content mismatch fails even with same thread id", async () => {
  const x = await exec();
  x.steps.find((s) => s.action.tool === "read")!.observation.artifact!.units[0].text = "changed";
  assert.equal(rules(taskOf(), x).checks.find((c) => c.id.startsWith("persistence:"))!.pass, false);
});
test("generated evidence must belong to the actual selection", async () => {
  const x = await exec();
  x.steps.find((s) => s.action.tool === "generate")!.action.sourceIds = ["a"];
  assert.equal(
    rules(taskOf(), x).checks.find((c) => c.id.startsWith("selected_membership:"))!.pass,
    false,
  );
});
test("valid quotes do not guarantee a supported conclusion", async () => {
  const g = await grade(
    taskOf(),
    await exec(),
    async (input) => ({
      taskComplete: true,
      reason: "overbroad claim",
      units: input.units.map((u) => ({ id: u.id, supported: false, relevant: true })),
    }),
    context(),
  );
  assert.equal(g.metrics.quoteContainment, true);
  assert.equal(g.metrics.sourceBinding, true);
  assert.equal(g.verdict, "fail");
});
test("truthful content can still fail the original task", async () => {
  const g = await grade(
    taskOf(),
    await exec(),
    async (input) => ({
      taskComplete: false,
      reason: "task incomplete",
      units: input.units.map((u) => ({ id: u.id, supported: true, relevant: true })),
    }),
    context(),
  );
  assert.equal(g.metrics.unsupportedRate, 0);
  assert.equal(g.metrics.taskComplete, false);
  assert.equal(g.verdict, "fail");
});
test("over-refusal is separate from unsupported-content rate", async () => {
  const x = await exec();
  x.turns[0].answer = {
    status: "evidence_gap",
    text: "Insufficient evidence",
    citations: [],
    nextQueries: ["query"],
  };
  const g = rules(taskOf(), x);
  assert.equal(g.metrics.overRefusals, 1);
  assert.equal(g.metrics.unsupportedRate, null);
  assert.equal(g.rules, "fail");
});
test("a justified evidence gap passes rules", async () => {
  const t = taskOf();
  t.input.followUps = ["未覆盖的问题"];
  t.expected.answerability = ["insufficient"];
  t.expected.supplement = true;
  const g = rules(t, await exec(t));
  assert.equal(g.metrics.correctGaps, 1);
  assert.equal(g.rules, "pass");
});
test("gap recovery suggestion must be nonempty when required", async () => {
  const t = taskOf();
  t.input.followUps = ["未覆盖的问题"];
  t.expected.answerability = ["insufficient"];
  t.expected.supplement = true;
  const x = await exec(t);
  x.turns[0].answer.nextQueries = [];
  assert.equal(rules(t, x).rules, "fail");
});
test("synonym attribution checks each accepted expression", async () => {
  const t = taskOf();
  t.expected.concepts = [["执行计划", "查询计划"]];
  const x = await exec(t);
  for (const step of x.steps)
    if (step.observation.artifact)
      step.observation.artifact.units = step.observation.artifact.units.filter((u) => u.id !== "b");
  assert.equal(rules(t, x).checks.find((c) => c.id === "concept:0")!.detail, "generation_missing");
});
test("keywords only inside quotes do not count as generated explanation", async () => {
  const t = taskOf();
  const x = await exec();
  for (const step of x.steps)
    for (const unit of step.observation.artifact?.units ?? []) unit.text = "解释";
  x.turns[0].answer.text = "回复";
  assert.equal(rules(t, x).checks.find((c) => c.id === "concept:0")!.pass, false);
});
test("user input containing forbidden text is not an output violation", async () => {
  const t = taskOf();
  t.input.question = "请勿输出 marker";
  t.expected.forbiddenText = ["marker"];
  assert.equal(
    rules(t, await exec(t)).checks.find((c) => c.id.startsWith("forbidden_text:"))!.pass,
    true,
  );
});
test("configured secret in output blocks grading before forwarding it", async () => {
  const x = await exec();
  x.turns[0].answer.text = "secret-value";
  let invoked = false;
  const g = await grade(
    taskOf(),
    x,
    async () => {
      invoked = true;
      return {};
    },
    context(),
    ["secret-value"],
  );
  assert.equal(g.verdict, "fail");
  assert.equal(invoked, false);
});
test("first success and retry success are distinct", async () => {
  const r = await runCase(taskOf(), { createPort: async () => fixturePort(), judge });
  assert.equal(r.firstAttemptSuccess, true);
  assert.equal(r.retrySuccess, false);
  assert.equal(r.attempts.length, 1);
});
test("retry recovery retains both attempts and their full usage", async () => {
  let environments = 0;
  const r = await runCase(taskOf(), {
    judge,
    createPort: async (_r, n) => {
      environments++;
      return fixturePort({
        override: (a) =>
          n === 1 && a.tool === "search"
            ? { status: "error", code: "HTTP_503", retryable: true }
            : undefined,
      });
    },
  });
  assert.equal(environments, 2);
  assert.equal(r.firstAttemptSuccess, false);
  assert.equal(r.retrySuccess, true);
  assert.equal(r.attempts.length, 2);
  assert.equal(
    r.totals.calls,
    r.attempts.reduce((sum, a) => sum + a.calls.length, 0),
  );
  assert.equal(r.totals.calls, 9);
  assert.ok(r.wallMs >= r.attempts.reduce((sum, a) => sum + a.wallMs, 0));
});
test("quality failure does not trigger score-shopping retries", async () => {
  const t = taskOf();
  t.expected.concepts = [["unreachable"]];
  const r = await runCase(t, { createPort: async () => fixturePort(), judge });
  assert.equal(r.attempts.length, 1);
  assert.equal(r.finalVerdict, "fail");
});
test("missing usage is null with known subtotals", () => {
  const ledger = createLedger(5);
  const r = ledger.runtime(new AbortController().signal);
  r.beginCall("product", "model", "fixture")({ status: "ok", usage: fixtureUsage });
  r.beginCall("judge", "model", "fixture")({ status: "error" });
  const sum = totals(ledger.close());
  assert.equal(sum.inputTokens, null);
  assert.equal(sum.knownInputTokens, 10);
  assert.equal(sum.unknownTokenCalls, 1);
  assert.equal(sum.costUsd, null);
});
test("search requests are not unknown model token requests", () => {
  const ledger = createLedger(5);
  ledger.runtime(new AbortController().signal).beginCall("product", "search", "fixture")({
    status: "ok",
    usage: { costUsd: 0 },
  });
  assert.equal(totals(ledger.close()).unknownTokenCalls, 0);
});
test("aborted calls remain in usage even without a response", () => {
  const ledger = createLedger(5);
  const abort = new AbortController();
  const end = ledger.runtime(abort.signal).beginCall("product", "model", "fixture");
  abort.abort();
  end({ status: "ok", usage: fixtureUsage });
  const calls = ledger.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "aborted");
  assert.equal(calls[0].inputTokens, null);
});
test("deadline bounds a non-resolving tool", async () => {
  const r = await runCase(taskOf(), {
    executionTimeoutMs: 5,
    createPort: async () => ({ invoke: async () => new Promise(() => {}) }),
  });
  assert.equal(r.attempts[0].execution.outcome, "budget_exceeded");
});
test("deadline bounds a non-resolving judge without false success", async () => {
  const r = await runCase(taskOf(), {
    judgeTimeoutMs: 5,
    createPort: async () => fixturePort(),
    judge: async () => new Promise(() => {}),
  });
  assert.equal(r.attempts[0].grade.semantics, "unavailable");
  assert.equal(r.finalVerdict, "unjudged");
});
test("call budget does not allow extra requests", async () => {
  const r = await runCase(taskOf(), { maxCalls: 1, createPort: async () => fixturePort() });
  assert.equal(r.totals.calls, 1);
  assert.equal(r.attempts[0].execution.outcome, "budget_exceeded");
});
test("autonomous policy sees observations but not expected", async () => {
  const t = taskOf();
  t.mode = "autonomous";
  const r = await runCase(t, {
    createPort: async () =>
      fixturePort({
        policy: async (v) => {
          assert.equal("expected" in v, false);
          assert.equal("expected" in v.input, false);
          return fixturePolicy(v);
        },
      }),
  });
  assert.equal(r.firstAttemptRulesPass, true);
});
test("autonomous tool failure can be recovered within the same attempt", async () => {
  let failed = false;
  const t = taskOf();
  t.mode = "autonomous";
  const r = await runCase(t, {
    createPort: async () =>
      fixturePort({
        override: (a) => {
          if (a.tool === "search" && !failed) {
            failed = true;
            return { status: "error", code: "HTTP_503", retryable: true };
          }
        },
        policy: async (v) =>
          v.observations.at(-1)?.observation.status === "error"
            ? { tool: "search", query: "retry query" }
            : fixturePolicy(v),
      }),
  });
  assert.equal(r.firstAttemptRulesPass, true);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].execution.steps.filter((s) => s.action.tool === "search").length, 2);
});
test("autonomous endless policy is stopped by step budget", async () => {
  const t = taskOf();
  t.mode = "autonomous";
  const r = await runCase(t, {
    maxSteps: 3,
    createPort: async () =>
      fixturePort({ policy: async () => ({ tool: "search", query: "query" }) }),
  });
  assert.equal(r.attempts[0].execution.outcome, "budget_exceeded");
  assert.equal(r.attempts[0].execution.steps.length, 3);
});
test("premature finish is rejected", async () => {
  const t = taskOf();
  t.mode = "autonomous";
  const r = await runCase(t, {
    createPort: async () => fixturePort({ policy: async () => ({ tool: "finish" }) }),
  });
  assert.equal(r.firstAttemptRulesPass, false);
});
test("unknown tools are rejected", () =>
  assert.throws(() => parseAction({ tool: "shell", query: "echo" })));
test("unknown selected sources are rejected before generation", async () => {
  const t = taskOf();
  t.input.selectedSourceIds = ["missing"];
  const x = await exec(t);
  assert.equal(x.outcome, "error");
  assert.equal(
    x.steps.some((s) => s.action.tool === "generate"),
    false,
  );
});
test("model policy adapter parses actual observations and does not receive labels", async () => {
  let modelCalls = 0;
  const p = makePolicy(async (messages) => {
    modelCalls++;
    const view = JSON.parse(messages[1].content);
    assert.equal("expected" in view, false);
    return JSON.stringify(await fixturePolicy(view));
  });
  const t = taskOf();
  t.mode = "autonomous";
  const r = await runCase(t, { createPort: async () => fixturePort({ policy: p }) });
  assert.equal(r.firstAttemptRulesPass, true);
  assert.ok(modelCalls > 1);
});
test("changed-file selection targets real regression contracts", () => {
  const chosen = selectTasks(scenarios(), { changedFiles: ["src/evals/v3/execution.ts"] });
  assert.ok(chosen.length > 0);
  assert.ok(chosen.every((t) => t.purpose === "regression"));
  assert.ok(chosen.some((t) => t.id === "reg-product-refusal"));
});
test("offset skips tasks independently of stride", () => {
  const all = scenarios();
  assert.equal(selectTasks(all, { offset: 2, limit: 1 })[0].id, all[2].id);
});
test("unknown task id is not silently ignored", () =>
  assert.throws(() => selectTasks(scenarios(), { ids: ["missing"] })));
test("duplicate ids and malformed expectations are rejected", () => {
  assert.throws(() => selectTasks([taskOf(), taskOf()]));
  const t = taskOf();
  t.expected.concepts = [[""]];
  assert.throws(() => validateTask(t));
});
test("real regressions must name contract and affected paths", () => {
  const t = taskOf();
  t.purpose = "regression";
  assert.throws(() => validateTask(t));
});
test("comparison rejects different scoring or fixture conditions", async () => {
  const a = await reportFor();
  const b = structuredClone(a);
  b.measurement.fixtureHash = "different";
  assert.equal(compare(a, b).comparable, false);
});
test("comparison rejects incomplete and changed task sets", async () => {
  const a = await reportFor();
  const b = structuredClone(a);
  b.complete = false;
  assert.equal(compare(a, b).comparable, false);
  b.complete = true;
  b.cases[0].taskHash = "changed";
  assert.equal(compare(a, b).comparable, false);
});
test("first-attempt regression is not concealed by retry recovery", async () => {
  const a = await reportFor(scenarios().find((t) => t.purpose === "regression")!);
  const b = structuredClone(a);
  b.cases[0].firstAttemptRulesPass = false;
  b.cases[0].retryRulesPass = true;
  assert.deepEqual(compare(a, b).regressions, [a.cases[0].id]);
});
test("unjudged quality is distinct from a measured semantic regression", async () => {
  const a = await reportFor();
  const b = structuredClone(a);
  a.cases[0].firstAttemptSuccess = true;
  const result = compare(a, b);
  assert.deepEqual(result.semanticRegressions, []);
  assert.deepEqual(result.unjudgedAfter, [b.cases[0].id]);
});
test("report exposes every attempt and phase usage", async () => {
  const r = await reportFor();
  const text = markdown(r);
  assert.ok(text.includes("unjudged"));
  assert.ok(text.includes("attempt 1"));
  assert.ok(text.includes("By phase"));
  assert.equal(r.totalsByPhase.product.calls, r.totals.calls);
});
test("offline network rejects real requests before fetch", async () => {
  let requests = 0;
  const n = installNetwork({
    live: false,
    origins: ["https://example.invalid"],
    maxRunCalls: 10,
    fetcher: async () => {
      requests++;
      return Response.json({});
    },
  });
  try {
    await assert.rejects(n.scope(context(), "product", () => fetch("https://example.invalid")));
    assert.equal(requests, 0);
  } finally {
    n.restore();
  }
});
test("unscoped and off-origin requests are denied", async () => {
  const n = installNetwork({ live: false, origins: ["https://example.invalid"], maxRunCalls: 10 });
  try {
    await assert.rejects(fetch("https://example.invalid"));
    await assert.rejects(
      n.scope(
        context(),
        "product",
        () => fetch("https://other.invalid"),
        async () => Response.json({}),
      ),
    );
  } finally {
    n.restore();
  }
});
test("network meters every response including token usage and phase", async () => {
  const ledger = createLedger(10);
  const n = installNetwork({ live: false, origins: ["https://example.invalid"], maxRunCalls: 10 });
  try {
    await n.scope(
      ledger.runtime(new AbortController().signal),
      "judge",
      () => fetch("https://example.invalid/chat/completions"),
      async (_url, init) => {
        assert.equal(init?.redirect, "error");
        return Response.json({ usage: { prompt_tokens: 9, completion_tokens: 4 } });
      },
    );
    const calls = ledger.close();
    assert.equal(calls[0].phase, "judge");
    assert.equal(calls[0].inputTokens, 9);
    assert.equal(calls[0].provenance, "fixture");
  } finally {
    n.restore();
  }
});
test("run network budget counts all attempts", async () => {
  const n = installNetwork({ live: false, origins: ["https://example.invalid"], maxRunCalls: 1 });
  try {
    await n.scope(
      context(),
      "product",
      () => fetch("https://example.invalid"),
      async () => Response.json({}),
    );
    await assert.rejects(
      n.scope(
        context(),
        "product",
        () => fetch("https://example.invalid"),
        async () => Response.json({}),
      ),
    );
    assert.equal(n.exhausted(), true);
    assert.equal(n.calls(), 1);
  } finally {
    n.restore();
  }
});
test("credential redaction covers nested values and named secrets", () => {
  const x = redact({ a: [{ body: "secret-value", authorization: "Bearer abc123" }] }, [
    "secret-value",
  ]);
  assert.equal(JSON.stringify(x).includes("secret-value"), false);
  assert.equal(JSON.stringify(x).includes("abc123"), false);
});
test("hash is stable across object key order", () =>
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 })));
test("fixture content is explicitly synthetic", () =>
  assert.ok(
    artifactOf().sources.every((s) => s.kind === "fixture" && s.url.includes("example.invalid")),
  ));
contracts.push(...bridgeContracts);
test("legacy conversion keeps execution identical when only expected changes", () => {
  const item = {
    id: "legacy",
    title: "legacy",
    category: "adversarial",
    input: { question: "query" },
    expected: { flow: "full" as const },
  };
  assert.deepEqual(
    adaptLegacy(item).input,
    adaptLegacy({ ...item, expected: { flow: "safe_no_thread" } }).input,
  );
});
