import type { Call, Phase, Runtime, Totals, Usage } from "./types.ts";
export class EvalError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const errorCode = (error: unknown, fallback: string): string => error instanceof EvalError ? error.code : fallback;
export const abortReason = (signal: AbortSignal): EvalError => signal.reason instanceof EvalError ? signal.reason : new EvalError("DEADLINE_EXCEEDED");
/** Observes late rejection even if the supplied operation was already started. */
export const bounded = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(abortReason(signal));
    signal.addEventListener("abort", cancel, { once: true });
    operation.then((value) => { signal.removeEventListener("abort", cancel); resolve(value); }, (error) => { signal.removeEventListener("abort", cancel); reject(error); });
  });
};
export const deadline = (ms: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new EvalError("DEADLINE_EXCEEDED")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
};
export const integer = (value: unknown, fallback: number, min = 1, max = 1000000): number => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new EvalError("INVALID_BUDGET");
  return n;
};
export const createLedger = (limit: number, now = () => performance.now()) => {
  const calls: Call[] = [];
  const starts = new Map<number, number>();
  let closed = false;
  let denied = false;
  const runtime = (signal: AbortSignal): Runtime => ({
    signal,
    beginCall: (phase, provider, provenance) => {
      if (closed)
        throw new EvalError("LEDGER_CLOSED");
      if (signal.aborted)
        throw abortReason(signal);
      if (calls.length >= limit) {
        denied = true;
        throw new EvalError("CALL_BUDGET_EXCEEDED");
      }
      const call: Call = { id: calls.length, phase, provider, provenance, status: "pending", durationMs: 0,
        inputTokens: null, outputTokens: null, costUsd: null };
      calls.push(call);
      starts.set(call.id, now());
      const cancel = () => {
        if (call.status !== "pending")
          return;
        call.status = "aborted";
        call.durationMs = now() - starts.get(call.id)!;
      };
      signal.addEventListener("abort", cancel, { once: true });
      return ({ status, usage = {}, httpStatus }) => {
        signal.removeEventListener("abort", cancel);
        if (closed || call.status !== "pending")
          return;
        call.status = status;
        call.durationMs = now() - starts.get(call.id)!;
        call.httpStatus = httpStatus;
        for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) {
          const v = usage[key];
          call[key] = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
        }
      };
    },
  });
  return {
    runtime,
    close: (): Call[] => {
      for (const call of calls)
        if (call.status === "pending") {
          call.status = "aborted";
          call.durationMs = now() - starts.get(call.id)!;
        }
      closed = true;
      return structuredClone(calls);
    },
    snapshot: (): Call[] => structuredClone(calls),
    denied: (): boolean => denied,
  };
};
export const totals = (calls: Call[]): Totals => {
  const models = calls.filter((call) => call.provider === "model");
  const sum = (values: Array<number | null>) => values.reduce<number>((a, b) => a + (b ?? 0), 0);
  const knownInputTokens = sum(models.map((call) => call.inputTokens));
  const knownOutputTokens = sum(models.map((call) => call.outputTokens));
  const knownCostUsd = sum(calls.map((call) => call.costUsd));
  return {
    calls: calls.length, knownInputTokens, knownOutputTokens,
    inputTokens: models.some((call) => call.inputTokens === null) ? null : knownInputTokens,
    outputTokens: models.some((call) => call.outputTokens === null) ? null : knownOutputTokens,
    unknownTokenCalls: models.filter((call) => call.inputTokens === null || call.outputTokens === null).length,
    costUsd: calls.some((call) => call.costUsd === null) ? null : knownCostUsd,
    knownCostUsd, unknownCostCalls: calls.filter((call) => call.costUsd === null).length,
    providerDurationMs: sum(calls.map((call) => call.durationMs)),
  };
};
export const phaseTotals = (calls: Call[]): Record<Phase, Totals> => ({
  product: totals(calls.filter((call) => call.phase === "product")),
  planner: totals(calls.filter((call) => call.phase === "planner")),
  judge: totals(calls.filter((call) => call.phase === "judge")),
});
export const fixtureUsage: Usage = { inputTokens: 10, outputTokens: 5, costUsd: 0 };
