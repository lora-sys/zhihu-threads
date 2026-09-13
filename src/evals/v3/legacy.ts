import type { Task } from "./types.ts";
interface LegacyCase {
  id: string;
  title: string;
  category: string;
  input: {
    question: string;
    followUps?: string[];
  };
  expected: {
    flow: "full" | "safe_no_thread";
    minSources?: number;
    mustInclude?: string[];
    mustIncludeAny?: string[][];
    mustNotInclude?: string[];
  };
}
/** Preserve historical data. Bug-labelled questions are capability probes until fault setup exists. */
export const adaptLegacy = (item: LegacyCase): Task => {
  const grouped = new Set((item.expected.mustIncludeAny ?? []).flat());
  return {
    id: item.id,
    title: item.title,
    purpose: "capability",
    mode: item.input.followUps?.length ? "multi_turn" : "workflow",
    input: {
      question: item.input.question,
      learningTask: item.input.question,
      followUps: structuredClone(
        item.input.followUps ?? ["请指出当前学习线的关键分歧和证据边界。"],
      ),
    },
    expected: {
      outcomes: item.expected.flow === "full" ? ["completed"] : ["refused", "evidence_gap"],
      minSources: item.expected.minSources,
      synthesis: item.expected.flow === "full",
      citations: true,
      concepts: [
        ...(item.expected.mustIncludeAny ?? []),
        ...(item.expected.mustInclude ?? [])
          .filter((term) => !grouped.has(term))
          .map((term) => [term]),
      ],
      forbiddenText: structuredClone(item.expected.mustNotInclude ?? []),
    },
  };
};
