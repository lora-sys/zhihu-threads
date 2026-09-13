import { describe, expect, it } from "vite-plus/test";

import { FEATURED_THREADS } from "./featured-threads";
import {
  FEATURED_THREAD_ARTIFACT_IDS,
  decodeFeaturedThreadArtifact,
  findFeaturedThreadArtifact,
} from "./featured-thread-artifacts";

// ── Shipped featured artifacts ──────────────────────────────────────────────

describe("featured thread artifacts", () => {
  it("ships an artifact for every featured thread card", () => {
    const featuredIds = FEATURED_THREADS.map((thread) => thread.threadId).sort();
    expect([...FEATURED_THREAD_ARTIFACT_IDS].sort()).toEqual(featuredIds);
  });

  it("decodes every shipped artifact through the domain factory", () => {
    for (const threadId of FEATURED_THREAD_ARTIFACT_IDS) {
      const artifact = findFeaturedThreadArtifact(threadId);
      expect(artifact, `artifact ${threadId} should decode`).not.toBeNull();
      expect(artifact?.threadId).toBe(threadId);
      expect(artifact?.timelineStages.length).toBeGreaterThan(0);
      expect(artifact?.learningNodes.length).toBeGreaterThan(0);
    }
  });

  it("matches the summary card metadata so the card and the page agree", () => {
    for (const thread of FEATURED_THREADS) {
      const artifact = findFeaturedThreadArtifact(thread.threadId);
      expect(artifact, `artifact ${thread.threadId} should decode`).not.toBeNull();
      expect(artifact?.timelineStages.length).toBe(thread.stageCount);
      expect(artifact?.learningNodes.length).toBe(thread.nodeCount);
    }
  });

  it("returns null for unknown thread ids", () => {
    expect(findFeaturedThreadArtifact("0000000000000000")).toBeNull();
  });

  it("rejects malformed payloads instead of trusting them", () => {
    expect(decodeFeaturedThreadArtifact(null)).toBeNull();
    expect(decodeFeaturedThreadArtifact("not-an-artifact")).toBeNull();
    expect(decodeFeaturedThreadArtifact({ threadId: "7717a55363d44765" })).toBeNull();
  });
});
