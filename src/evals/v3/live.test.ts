import { describe, expect, it } from "vite-plus/test";
import { runLive } from "./live.ts";
describe("explicit eval v3 command", () => {
  it(
    "runs only on explicit command opt-in",
    async () => {
      if (process.env.EVAL_V3_COMMAND !== "run") {
        expect(process.env.EVAL_V3_COMMAND).toBeUndefined();
        return;
      }
      const report = await runLive();
      expect(report.complete).toBe(true);
      // Regression gates concern first-attempt contracts, not cherry-picked recoveries.
      expect(
        report.cases
          .filter((c) => c.purpose === "regression")
          .every((c) => c.firstAttemptRulesPass),
      ).toBe(true);
      if (process.env.EVAL_REQUIRE_SEMANTICS === "1")
        expect(report.cases.every((c) => c.finalVerdict === "pass")).toBe(true);
    },
    Number(process.env.EVAL_TIMEOUT_MS ?? 14400000),
  );
});
