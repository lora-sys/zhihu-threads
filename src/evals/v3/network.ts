import { AsyncLocalStorage } from "node:async_hooks";
import type { Phase, Runtime } from "./types.ts";
import { EvalError } from "./runtime.ts";
interface Scope {
  runtime: Runtime;
  phase: Phase;
  fixtureFetch?: typeof fetch;
}
let installed = false;
/** For a dedicated eval process. Never patches production transport files. */
export const installNetwork = (options: {
  live: boolean;
  origins: string[];
  maxRunCalls: number;
  fetcher?: typeof fetch;
}) => {
  if (installed)
    throw new EvalError("NETWORK_SCOPE_ALREADY_INSTALLED");
  const original = globalThis.fetch;
  const fetcher = options.fetcher ?? original;
  const scopes = new AsyncLocalStorage<Scope>();
  let calls = 0;
  let runBudgetExceeded = false;
  installed = true;
  globalThis.fetch = async (input, init) => {
    const scope = scopes.getStore();
    if (!scope)
      throw new EvalError("UNSCOPED_EVAL_NETWORK_REQUEST");
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!options.origins.includes(url.origin) || url.username || url.password)
      throw new EvalError("NETWORK_ORIGIN_DENIED");
    if (!scope.fixtureFetch && !options.live)
      throw new EvalError("OFFLINE_NETWORK_DENIED");
    if (calls >= options.maxRunCalls) {
      runBudgetExceeded = true;
      throw new EvalError("RUN_CALL_BUDGET_EXCEEDED");
    }
    const provider = url.pathname.endsWith("/chat/completions") ? "model" : "search";
    const settle = scope.runtime.beginCall(scope.phase, provider, scope.fixtureFetch ? "fixture" : "live");
    calls++;
    const signals = [scope.runtime.signal, init?.signal, input instanceof Request ? input.signal : undefined].filter((s): s is AbortSignal => Boolean(s));
    try {
      const response = await (scope.fixtureFetch ?? fetcher)(input, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      if (provider === "model") {
        try {
          const raw = await response.clone().json() as {
            usage?: Record<string, unknown>;
          };
          const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
          inputTokens = number(raw.usage?.prompt_tokens ?? raw.usage?.input_tokens);
          outputTokens = number(raw.usage?.completion_tokens ?? raw.usage?.output_tokens);
        }
        catch { /* Usage absent or malformed stays unknown, not zero. */ }
      }
      settle({ status: response.ok ? "ok" : "error", httpStatus: response.status,
        usage: { inputTokens, outputTokens, costUsd: scope.fixtureFetch ? 0 : null } });
      return response;
    }
    catch (error) {
      settle({ status: "error" });
      throw error;
    }
  };
  return {
    scope: <T>(runtime: Runtime, phase: Phase, operation: () => Promise<T>, fixtureFetch?: typeof fetch): Promise<T> => scopes.run({ runtime, phase, fixtureFetch }, operation),
    calls: () => calls,
    exhausted: () => runBudgetExceeded,
    restore: () => { globalThis.fetch = original; installed = false; scopes.disable(); },
  };
};
export type Network = ReturnType<typeof installNetwork>;
