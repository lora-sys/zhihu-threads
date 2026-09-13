import { describe, expect, it } from "vite-plus/test";

import type { CollectedThreadSummary } from "./thread-collection";
import { mergeWorkspaceThreads } from "./workspace-threads";

const makeSummary = (threadId: string, question: string): CollectedThreadSummary => ({
  threadId,
  question,
  createdAt: 1_700_000_000_000,
  sourceCount: 2,
  nodeCount: 3,
  yearRange: "2024—2025",
});

describe("mergeWorkspaceThreads", () => {
  it("keeps local-only threads for signed-out-to-signed-in upgrades", () => {
    const local = [makeSummary("aaaaaaaaaaaaaaaa", "本机收集")];
    expect(mergeWorkspaceThreads(local, [])).toEqual(local);
  });

  it("adds account threads that this device has never seen", () => {
    const account = [makeSummary("bbbbbbbbbbbbbbbb", "另一台设备收集")];
    expect(mergeWorkspaceThreads([], account)).toEqual(account);
  });

  it("prefers the account copy when both hold the same thread", () => {
    const local = [makeSummary("cccccccccccccccc", "旧标题")];
    const account = [makeSummary("cccccccccccccccc", "账号里的新标题")];

    const merged = mergeWorkspaceThreads(local, account);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.question).toBe("账号里的新标题");
  });

  it("keeps every distinct thread from both sides", () => {
    const local = [makeSummary("aaaaaaaaaaaaaaaa", "本地 A")];
    const account = [
      makeSummary("bbbbbbbbbbbbbbbb", "账号 B"),
      makeSummary("cccccccccccccccc", "账号 C"),
    ];

    expect(mergeWorkspaceThreads(local, account).map((item) => item.threadId)).toEqual([
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
      "cccccccccccccccc",
    ]);
  });
});
