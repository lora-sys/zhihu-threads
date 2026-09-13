import type {
  Action,
  Artifact,
  Execution,
  Input,
  Mode,
  Observation,
  Port,
  Runtime,
  Source,
  Step,
  Turn,
  View,
} from "./types.ts";
import { abortReason, bounded, errorCode, EvalError } from "./runtime.ts";
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const nonempty = (v: unknown): v is string => string(v) && v.trim() !== "";
export const validSource = (v: unknown): v is Source =>
  object(v) &&
  nonempty(v.id) &&
  nonempty(v.fingerprint) &&
  string(v.text) &&
  v.text.length > 0 &&
  nonempty(v.url) &&
  (v.author === null || string(v.author));
const validCitation = (v: unknown): boolean =>
  object(v) &&
  nonempty(v.sourceId) &&
  nonempty(v.fingerprint) &&
  string(v.quote) &&
  nonempty(v.url) &&
  (v.author === undefined || string(v.author));
const validUnits = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.every(
    (u) =>
      object(u) &&
      nonempty(u.id) &&
      string(u.text) &&
      ["claim", "boundary", "guidance"].includes(String(u.kind)) &&
      Array.isArray(u.citations) &&
      u.citations.every(validCitation),
  );
export const validArtifact = (v: unknown): v is Artifact =>
  object(v) &&
  nonempty(v.id) &&
  ["synthesized", "evidence_only"].includes(String(v.mode)) &&
  Array.isArray(v.sources) &&
  v.sources.every(validSource) &&
  validUnits(v.units);
export const parseAction = (v: unknown): Action => {
  if (
    !object(v) ||
    !["clarify", "search", "rank", "generate", "read", "ask", "finish", "refuse"].includes(
      String(v.tool),
    )
  )
    throw new EvalError("INVALID_ACTION");
  if (v.query !== undefined && (!string(v.query) || v.query.length > 10000))
    throw new EvalError("INVALID_ACTION_QUERY");
  if (
    v.sourceIds !== undefined &&
    (!Array.isArray(v.sourceIds) || v.sourceIds.length > 20 || !v.sourceIds.every(nonempty))
  )
    throw new EvalError("INVALID_SELECTION");
  if (v.message !== undefined && (!string(v.message) || v.message.length > 5000))
    throw new EvalError("INVALID_ACTION_MESSAGE");
  return {
    tool: v.tool as Action["tool"],
    ...(v.query !== undefined ? { query: v.query as string } : {}),
    ...(v.sourceIds ? { sourceIds: [...(v.sourceIds as string[])] } : {}),
    ...(v.message !== undefined ? { message: v.message as string } : {}),
  };
};
const parseObservation = (action: Action, v: unknown): Observation => {
  if (!object(v) || !["ok", "error", "refused", "evidence_gap"].includes(String(v.status)))
    throw new EvalError("INVALID_OBSERVATION");
  if (v.status === "error" && (!nonempty(v.code) || typeof v.retryable !== "boolean"))
    throw new EvalError("INVALID_ERROR_CONTRACT");
  if (["refused", "evidence_gap"].includes(String(v.status)) && !nonempty(v.message))
    throw new EvalError("MISSING_BOUNDARY_MESSAGE");
  if (v.units !== undefined && !validUnits(v.units)) throw new EvalError("INVALID_VISIBLE_UNITS");
  if (v.sources !== undefined && (!Array.isArray(v.sources) || !v.sources.every(validSource)))
    throw new EvalError("INVALID_SOURCES");
  if (v.artifact !== undefined && !validArtifact(v.artifact))
    throw new EvalError("INVALID_ARTIFACT");
  if (v.status === "ok") {
    if (action.tool === "clarify" && !nonempty(v.query))
      throw new EvalError("INVALID_CLARIFICATION");
    if (action.tool === "search" && !Array.isArray(v.sources))
      throw new EvalError("MISSING_SOURCES");
    if (action.tool === "rank" && (!Array.isArray(v.rankedIds) || !v.rankedIds.every(nonempty)))
      throw new EvalError("INVALID_RANKING");
    if (["generate", "read"].includes(action.tool) && !validArtifact(v.artifact))
      throw new EvalError("MISSING_ARTIFACT");
    if (action.tool === "ask") {
      const a = v.answer;
      if (
        !object(a) ||
        !["answered", "evidence_gap", "refused"].includes(String(a.status)) ||
        !nonempty(a.text) ||
        !Array.isArray(a.citations) ||
        !a.citations.every(validCitation) ||
        !Array.isArray(a.nextQueries) ||
        !a.nextQueries.every(string)
      )
        throw new EvalError("INVALID_ANSWER");
    }
  }
  return structuredClone(v) as unknown as Observation;
};
/** Select only declared input fields. Task ids, expected labels and regression metadata stay out. */
const publicInput = (input: Input): Input =>
  structuredClone({
    question: input.question,
    learningTask: input.learningTask,
    followUps: input.followUps,
    sources: input.sources,
    artifact: input.artifact,
    selectedSourceIds: input.selectedSourceIds,
    step: input.step,
  });
export const execute = async (
  input: Input,
  mode: Mode,
  port: Port,
  runtime: Runtime,
  maxSteps = 16,
): Promise<Execution> => {
  const start = performance.now();
  const original = publicInput(input);
  const steps: Step[] = [];
  const turns: Turn[] = [];
  let artifact = original.artifact;
  const sources: Source[] = structuredClone(original.sources ?? artifact?.sources ?? []);
  let readVerified = Boolean(original.artifact);
  let outcome: Execution["outcome"] = "error";
  let error: Execution["error"];
  const result = (): Execution =>
    structuredClone({
      outcome,
      steps,
      turns,
      sources,
      artifact,
      error,
      durationMs: performance.now() - start,
    });
  const fail = (code: string, retryable = false) => {
    error = { code, retryable };
    outcome = /BUDGET|DEADLINE/.test(code) ? "budget_exceeded" : "error";
  };
  const latestSources = (): Source[] => [
    ...new Map(sources.map((source) => [source.id, source])).values(),
  ];
  const view = (): View =>
    structuredClone({
      input: original,
      sources: latestSources(),
      artifact,
      turns,
      observations: steps,
      remainingSteps: maxSteps - steps.length,
    });
  const perform = async (raw: Action): Promise<Observation> => {
    if (runtime.signal.aborted) throw abortReason(runtime.signal);
    if (steps.length >= maxSteps) throw new EvalError("STEP_BUDGET_EXCEEDED");
    const action = parseAction(raw);
    const began = performance.now();
    let observation: Observation;
    if (action.tool === "finish") {
      if (!artifact || !readVerified) throw new EvalError("FINISH_WITHOUT_VERIFIED_ARTIFACT");
      outcome = "completed";
      observation = { status: "ok" };
    } else if (action.tool === "refuse") {
      if (!nonempty(action.message)) throw new EvalError("MISSING_REFUSAL");
      outcome = "refused";
      observation = { status: "refused", message: action.message };
    } else {
      if (["read", "ask"].includes(action.tool) && !artifact)
        throw new EvalError("ARTIFACT_REQUIRED");
      if (action.tool === "generate") {
        const selected =
          action.sourceIds ??
          original.selectedSourceIds ??
          latestSources()
            .slice(0, 3)
            .map((source) => source.id);
        if (
          !selected.length ||
          new Set(selected).size !== selected.length ||
          selected.some((id) => !sources.some((source) => source.id === id))
        )
          throw new EvalError("INVALID_SELECTION");
        action.sourceIds = [...selected];
      }
      try {
        observation = parseObservation(
          action,
          await bounded(port.invoke(structuredClone(action), view(), runtime), runtime.signal),
        );
      } catch (caught) {
        observation = {
          status: "error",
          code: errorCode(caught, "TOOL_EXCEPTION"),
          retryable: false,
        };
      }
      if (observation.status === "ok" && observation.sources) {
        for (const source of observation.sources) {
          const previous = sources.find(
            (item) => item.id === source.id && item.fingerprint === source.fingerprint,
          );
          if (previous && JSON.stringify(previous) !== JSON.stringify(source))
            throw new EvalError("CONFLICTING_SOURCE_SNAPSHOT");
          if (!previous) sources.push(structuredClone(source));
        }
      }
      if (observation.artifact) {
        artifact = observation.artifact;
        readVerified = action.tool === "read";
      }
      if (observation.answer)
        turns.push({
          question: action.query ?? original.question,
          answer: observation.answer,
          available: structuredClone(sources),
          selected: structuredClone(artifact?.sources ?? []),
        });
    }
    steps.push({
      index: steps.length,
      action,
      observation,
      durationMs: performance.now() - began,
      available: structuredClone(sources),
    });
    if (runtime.signal.aborted) throw abortReason(runtime.signal);
    if (observation.status === "refused" || observation.status === "evidence_gap")
      outcome = observation.status;
    return observation;
  };
  const next = async (action: Action): Promise<Observation | undefined> => {
    const observation = await perform(action);
    if (observation.status === "error") {
      fail(observation.code!, observation.retryable);
      return undefined;
    }
    return observation.status === "ok" ? observation : undefined;
  };
  try {
    if (
      typeof original.question !== "string" ||
      !sources.every(validSource) ||
      (artifact && !validArtifact(artifact))
    )
      throw new EvalError("INVALID_SETUP");
    if (mode === "single_step") {
      if (!original.step || ["finish", "refuse"].includes(original.step.tool))
        throw new EvalError("SINGLE_STEP_REQUIRED");
      const response = await next(original.step);
      if (response)
        outcome =
          response.answer?.status === "evidence_gap"
            ? "evidence_gap"
            : response.answer?.status === "refused"
              ? "refused"
              : "completed";
      return result();
    }
    if (mode === "autonomous") {
      if (!port.decide) throw new EvalError("POLICY_REQUIRED");
      for (let count = 0; count < maxSteps; count++) {
        if (runtime.signal.aborted) throw abortReason(runtime.signal);
        const action = parseAction(await bounded(port.decide(view(), runtime), runtime.signal));
        const response = await perform(action);
        if (action.tool === "finish" || response.status === "refused") return result();
        // Transient tool failures/gaps remain observations; the policy can recover within its budget.
        if (response.status === "error" && !response.retryable) {
          fail(response.code!);
          return result();
        }
      }
      throw new EvalError("STEP_BUDGET_EXCEEDED");
    }
    const clarification = await next({ tool: "clarify", query: original.question });
    if (!clarification) return result();
    if (!(await next({ tool: "search", query: clarification.query }))) return result();
    if (!sources.length) {
      outcome = "evidence_gap";
      return result();
    }
    const ranked = await next({ tool: "rank", query: clarification.query });
    if (!ranked) return result();
    const known = new Set(sources.map((source) => source.id));
    const selected =
      original.selectedSourceIds ??
      [...new Set([...(ranked.rankedIds ?? []).filter((id) => known.has(id)), ...known])].slice(
        0,
        3,
      );
    if (!(await next({ tool: "generate", sourceIds: selected }))) return result();
    if (!(await next({ tool: "read" }))) return result();
    for (const question of original.followUps ?? [original.learningTask ?? original.question]) {
      if (!(await next({ tool: "ask", query: question }))) return result();
    }
    outcome = "completed";
  } catch (caught) {
    fail(errorCode(caught, "EXECUTION_EXCEPTION"));
  }
  return result();
};
