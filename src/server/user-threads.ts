/**
 * Account-scoped learning space.
 *
 * A visitor without a Zhihu session keeps the local-first behaviour (their
 * collection stays in the browser). A signed-in visitor gets the same actions
 * mirrored into the shared database under their Zhihu user id, so the workspace
 * follows the account across devices.
 *
 * @module user-threads
 */

import { Effect } from "effect";
import { createServerFn } from "@tanstack/react-start";

import {
  isValidCollectedThreadSummary,
  type CollectedThreadSummary,
} from "../lib/thread-collection";
import { makeSqliteUserThreadStore, type UserThreadStore } from "../lib/user-thread-store";
import { readViewer } from "./zhihu-session";

// ── Responses ───────────────────────────────────────────────────────────────

export type MyThreadsResponse =
  | { readonly authenticated: false }
  | {
      readonly authenticated: true;
      readonly threads: readonly CollectedThreadSummary[];
      /** True when the account store could not be read; the client keeps local data. */
      readonly unavailable?: true;
    };

export type CollectionWriteReason = "NOT_AUTHENTICATED" | "INVALID_REQUEST" | "STORE_FAILED";

export type CollectionWriteResponse =
  | { readonly changed: true }
  | { readonly changed: false; readonly reason: CollectionWriteReason };

// ── Input parsing ───────────────────────────────────────────────────────────

const parseSummary = (input: unknown): CollectedThreadSummary | null => {
  if (typeof input !== "object" || input === null) return null;
  const summary = (input as { summary?: unknown }).summary;
  return isValidCollectedThreadSummary(summary) ? summary : null;
};

const parseThreadId = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null;
  const threadId = (input as { threadId?: unknown }).threadId;
  if (typeof threadId !== "string" || !/^[0-9a-f]{16}$/.test(threadId)) return null;
  return threadId;
};

// ── Handlers ────────────────────────────────────────────────────────────────

export interface UserThreadsDeps {
  readonly readViewerId: () => Promise<string | null>;
  readonly createStore: () => Promise<UserThreadStore>;
}

export const createListMyThreadsHandler =
  (deps: UserThreadsDeps) => async (): Promise<MyThreadsResponse> => {
    const userId = await deps.readViewerId();
    if (userId === null) return { authenticated: false };

    try {
      const store = await deps.createStore();
      const threads = await Effect.runPromise(store.list(userId));
      return { authenticated: true, threads };
    } catch {
      // A read failure must not look like an empty workspace.
      return { authenticated: true, threads: [], unavailable: true };
    }
  };

export const createSaveMyThreadHandler =
  (deps: UserThreadsDeps) =>
  async (input: unknown): Promise<CollectionWriteResponse> => {
    const userId = await deps.readViewerId();
    if (userId === null) return { changed: false, reason: "NOT_AUTHENTICATED" };

    const summary = parseSummary(input);
    if (summary === null) return { changed: false, reason: "INVALID_REQUEST" };

    try {
      const store = await deps.createStore();
      await Effect.runPromise(store.save(userId, summary));
      return { changed: true };
    } catch {
      return { changed: false, reason: "STORE_FAILED" };
    }
  };

export const createRemoveMyThreadHandler =
  (deps: UserThreadsDeps) =>
  async (input: unknown): Promise<CollectionWriteResponse> => {
    const userId = await deps.readViewerId();
    if (userId === null) return { changed: false, reason: "NOT_AUTHENTICATED" };

    const threadId = parseThreadId(input);
    if (threadId === null) return { changed: false, reason: "INVALID_REQUEST" };

    try {
      const store = await deps.createStore();
      await Effect.runPromise(store.remove(userId, threadId));
      return { changed: true };
    } catch {
      return { changed: false, reason: "STORE_FAILED" };
    }
  };

// ── Production wiring ───────────────────────────────────────────────────────

let storeInstance: Promise<UserThreadStore> | null = null;

const getOrCreateStore = async (): Promise<UserThreadStore> => {
  if (!storeInstance) {
    storeInstance = Effect.runPromise(makeSqliteUserThreadStore());
  }
  return storeInstance;
};

const deps: UserThreadsDeps = {
  readViewerId: async () => {
    const viewer = await readViewer();
    return viewer?.uid ?? null;
  },
  createStore: getOrCreateStore,
};

export const listMyThreadsFn = createServerFn({ method: "GET" }).handler(
  createListMyThreadsHandler(deps),
);

export const saveMyThreadFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(({ data }) => createSaveMyThreadHandler(deps)(data));

export const removeMyThreadFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(({ data }) => createRemoveMyThreadHandler(deps)(data));
