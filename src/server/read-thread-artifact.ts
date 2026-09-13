/**
 * Read-thread-artifact server function for the Question Learning Thread product.
 *
 * Loads a thread artifact by its opaque threadId, strictly validates it through
 * the domain factory, and returns a JSON-safe response.
 *
 * @module read-thread-artifact
 */

import { Effect } from "effect";
import { createServerFn } from "@tanstack/react-start";

import { findFeaturedThreadArtifact } from "../lib/featured-thread-artifacts";
import { makeSqliteThreadArtifactStore } from "../lib/thread-artifact-store";
import type { QuestionLearningThread } from "../lib/thread-artifact";

// ── Response types ─────────────────────────────────────────────────────────────

export type ReadThreadResponse =
  | {
      readonly success: true;
      readonly artifact: QuestionLearningThread;
    }
  | {
      readonly success: false;
      readonly code: "INVALID_REQUEST" | "ARTIFACT_NOT_FOUND" | "ARTIFACT_CORRUPTED";
      readonly message: string;
    };

// ── Handler factory ────────────────────────────────────────────────────────────

export interface ReadThreadDeps {
  readonly createThreadStore: () => Promise<
    import("../lib/thread-artifact-store").ThreadArtifactStore
  >;
  /**
   * Curated threads ship with the build, so a database without them (fresh
   * deployment, reset volume) still serves the featured links.
   */
  readonly findFallbackArtifact?: (threadId: string) => QuestionLearningThread | null;
}

export const createReadThreadHandler =
  (deps: ReadThreadDeps) =>
  async (input: { readonly threadId: string }): Promise<ReadThreadResponse> => {
    const threadId = typeof input?.threadId === "string" ? input.threadId.trim() : "";
    if (threadId === "") {
      return {
        success: false as const,
        code: "INVALID_REQUEST",
        message: "请输入有效的线程 ID。",
      };
    }

    try {
      const store = await deps.createThreadStore();
      const artifact = await Effect.runPromise(store.findById(threadId));

      if (artifact === null) {
        const fallback = deps.findFallbackArtifact?.(threadId) ?? null;
        if (fallback !== null) {
          return {
            success: true,
            artifact: fallback,
          };
        }

        return {
          success: false as const,
          code: "ARTIFACT_NOT_FOUND",
          message: "该学习线程不存在或已被移除。",
        };
      }

      return {
        success: true,
        artifact,
      };
    } catch {
      return {
        success: false as const,
        code: "ARTIFACT_CORRUPTED",
        message: "该学习线程数据损坏，无法加载。",
      };
    }
  };

// ── Input parser ───────────────────────────────────────────────────────────────

export const parseInput = (input: unknown): { readonly threadId: string } => {
  if (typeof input !== "object" || input === null || !("threadId" in input)) {
    return { threadId: "" };
  }
  const value = (input as { threadId: unknown }).threadId;
  return { threadId: typeof value === "string" ? value : "" };
};

// ── Production wiring ──────────────────────────────────────────────────────────

let threadStoreInstance: Promise<
  import("../lib/thread-artifact-store").ThreadArtifactStore
> | null = null;

const getOrCreateThreadStore = async () => {
  if (!threadStoreInstance) {
    threadStoreInstance = Effect.runPromise(makeSqliteThreadArtifactStore());
  }
  return threadStoreInstance;
};

export const readThreadArtifactFn = createServerFn({ method: "GET" })
  .validator(parseInput)
  .handler(async ({ data }): Promise<ReadThreadResponse> => {
    return createReadThreadHandler({
      createThreadStore: getOrCreateThreadStore,
      findFallbackArtifact: findFeaturedThreadArtifact,
    })(data);
  });
