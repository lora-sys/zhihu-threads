/**
 * Merge rules for the learning space.
 *
 * A visitor can collect threads without signing in, so the browser cache and
 * the account workspace can both hold entries. The account copy wins for the
 * same thread id because it is the one that survives a device change.
 *
 * @module workspace-threads
 */

import type { CollectedThreadSummary } from "./thread-collection";

export const mergeWorkspaceThreads = (
  local: readonly CollectedThreadSummary[],
  account: readonly CollectedThreadSummary[],
): readonly CollectedThreadSummary[] => {
  const merged = new Map<string, CollectedThreadSummary>();

  for (const thread of local) merged.set(thread.threadId, thread);
  for (const thread of account) merged.set(thread.threadId, thread);

  return Array.from(merged.values());
};
