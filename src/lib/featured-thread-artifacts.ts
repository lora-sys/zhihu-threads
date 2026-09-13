/**
 * Shipped copies of the curated featured learning threads.
 *
 * The home page links to fixed thread ids. A deployment with a fresh database
 * would otherwise show three cards that lead to "该学习线程不存在", so these
 * artifacts travel with the build instead of relying on a seeded database.
 *
 * Every artifact is decoded through the same domain factory that validates
 * database rows, so a malformed file can never reach React.
 *
 * @module featured-thread-artifacts
 */

import { createQuestionLearningThread } from "./thread-artifact";
import type {
  LearningGuideInput,
  LearningNodeInput,
  QuestionLearningThread,
  TimelineStageInput,
} from "./thread-artifact";

import algorithmArtifact from "../data/featured-thread-artifacts/3beed55578484f1b.json";
import databaseIndexArtifact from "../data/featured-thread-artifacts/376d90bd70194b24.json";
import reactServerComponentsArtifact from "../data/featured-thread-artifacts/7717a55363d44765.json";

const RAW_ARTIFACTS: ReadonlyMap<string, unknown> = new Map([
  ["7717a55363d44765", reactServerComponentsArtifact],
  ["376d90bd70194b24", databaseIndexArtifact],
  ["3beed55578484f1b", algorithmArtifact],
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Rebuild a featured artifact through the domain factory. Returns null when
 * the shipped JSON no longer satisfies the current domain contract.
 */
export const decodeFeaturedThreadArtifact = (value: unknown): QuestionLearningThread | null => {
  if (!isRecord(value)) return null;

  const result = createQuestionLearningThread({
    threadId: typeof value.threadId === "string" ? value.threadId : "",
    question: typeof value.question === "string" ? value.question : "",
    refinedQuery: typeof value.refinedQuery === "string" ? value.refinedQuery : "",
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Number.NaN,
    timelineStages: Array.isArray(value.timelineStages)
      ? (value.timelineStages as readonly TimelineStageInput[])
      : [],
    learningNodes: Array.isArray(value.learningNodes)
      ? (value.learningNodes as readonly LearningNodeInput[])
      : [],
    learningGuide: isRecord(value.learningGuide)
      ? (value.learningGuide as unknown as LearningGuideInput)
      : undefined,
    uncertainty: typeof value.uncertainty === "number" ? value.uncertainty : Number.NaN,
  });

  return result._tag === "success" ? result.artifact : null;
};

const decodedArtifacts = new Map<string, QuestionLearningThread | null>();

/**
 * Look up a shipped featured artifact by its fixed thread id.
 *
 * Decoding is memoized because the JSON is static for the lifetime of the
 * process and the factory re-validates every field.
 */
export const findFeaturedThreadArtifact = (threadId: string): QuestionLearningThread | null => {
  if (!RAW_ARTIFACTS.has(threadId)) return null;

  if (!decodedArtifacts.has(threadId)) {
    decodedArtifacts.set(threadId, decodeFeaturedThreadArtifact(RAW_ARTIFACTS.get(threadId)));
  }

  return decodedArtifacts.get(threadId) ?? null;
};

/** Ids of the shipped featured artifacts; used by tests and diagnostics. */
export const FEATURED_THREAD_ARTIFACT_IDS: readonly string[] = Array.from(RAW_ARTIFACTS.keys());
