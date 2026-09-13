/**
 * Immutable {@link QuestionLearningThread} factory.
 *
 * A thread artifact captures one user's fuzzy question, the clarified intent,
 * the selected real Zhihu answer excerpts, and the AI-synthesized learning nodes
 * in a single durable JSON record.
 *
 * Every field is validated before assembly. The factory never throws -- it
 * returns a discriminated union on validation failure.
 *
 * @module thread-artifact
 */

// ── FNV-1a fingerprint ────────────────────────────────────────────────────────

import { fnv1a64 } from "./answer-excerpt";
import { buildDeterministicLearningGuide } from "./thread-guide";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LearningNodeKind =
  | "relationship"
  | "cause"
  | "evolution"
  | "consensus"
  | "divergence"
  | "changed_premise"
  | "unknown";

export interface TimelineStage {
  readonly questionId: string;
  readonly answerId: string;
  readonly title: string;
  readonly authorDisplayName: string;
  readonly editTime: number;
  readonly canonicalUrl: string;
  readonly excerpt: {
    readonly questionId: string;
    readonly answerId: string;
    readonly capturedAt: number;
    readonly sourceContentId: string;
    readonly sourceContentType: "Answer" | "Article";
    readonly sourceEditTime: number;
    readonly excerpt: string;
    readonly fingerprint: string;
  };
  readonly excerptBoundaryNote: string;
}

export interface EvidenceRef {
  readonly excerptFingerprint: string;
  readonly quote: string;
}

export type LearningGuideRole =
  | "baseline"
  | "correction"
  | "extension"
  | "counterpoint"
  | "current_usage"
  | "unclear";

export interface LearningGuideEvidence {
  readonly answerId: string;
  readonly authorDisplayName: string;
  readonly title: string;
  readonly excerptFingerprint: string;
  readonly quote: string;
}

export interface LearningGuideOverview {
  readonly headline: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface LearningGuideStage {
  readonly answerId: string;
  readonly role: LearningGuideRole;
  readonly explanation: string;
  readonly transition?: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface LearningGuide {
  readonly overview: LearningGuideOverview;
  readonly stages: readonly LearningGuideStage[];
  readonly openQuestions: readonly string[];
}

export interface LearningGuideEvidenceInput {
  readonly answerId: string;
  readonly authorDisplayName: string;
  readonly title: string;
  readonly excerptFingerprint: string;
  readonly quote: string;
}

export interface LearningGuideOverviewInput {
  readonly headline: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRefInput[];
}

export interface LearningGuideStageInput {
  readonly answerId: string;
  readonly role: LearningGuideRole;
  readonly explanation: string;
  readonly transition?: string;
  readonly evidenceRefs: readonly EvidenceRefInput[];
}

export interface LearningGuideInput {
  readonly overview: LearningGuideOverviewInput;
  readonly stages: readonly LearningGuideStageInput[];
  readonly openQuestions: readonly string[];
}

export interface LearningNode {
  readonly kind: LearningNodeKind;
  readonly title: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly sourceAnswerId: string;
  readonly sourceUrl: string;
  readonly uncertainty: number;
}

export interface QuestionLearningThread {
  readonly threadId: string;
  readonly question: string;
  readonly refinedQuery: string;
  readonly createdAt: number;
  readonly timelineStages: readonly TimelineStage[];
  readonly learningNodes: readonly LearningNode[];
  readonly learningGuide: LearningGuide;
  readonly uncertainty: number;
  readonly fingerprint: string;
}

export interface ThreadArtifactInput {
  readonly threadId: string;
  readonly question: string;
  readonly refinedQuery: string;
  readonly createdAt: number;
  readonly timelineStages: readonly TimelineStageInput[];
  readonly learningNodes: readonly LearningNodeInput[];
  readonly learningGuide?: LearningGuideInput;
  readonly uncertainty: number;
}

export interface TimelineStageInput {
  readonly questionId: string;
  readonly answerId: string;
  readonly title: string;
  readonly authorDisplayName: string;
  readonly editTime: number;
  readonly canonicalUrl: string;
  readonly excerpt: {
    readonly questionId: string;
    readonly answerId: string;
    readonly capturedAt: number;
    readonly sourceContentId: string;
    readonly sourceContentType: string;
    readonly sourceEditTime: number;
    readonly excerpt: string;
    readonly fingerprint: string;
  };
}

export interface LearningNodeInput {
  readonly kind: LearningNodeKind;
  readonly title: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRefInput[];
  readonly sourceAnswerId: string;
  readonly sourceUrl: string;
  readonly uncertainty: number;
}

export interface EvidenceRefInput {
  readonly excerptFingerprint: string;
  readonly quote: string;
}

// ── Validation failure reasons ───────────────────────────────────────────────

export type ThreadArtifactFailureReason =
  | "INVALID_THREAD_ID"
  | "EMPTY_QUESTION"
  | "EMPTY_REFINED_QUERY"
  | "INVALID_CREATED_AT"
  | "EMPTY_TIMELINE"
  | "INVALID_TIMELINE_STAGE"
  | "EMPTY_LEARNING_NODES"
  | "INVALID_LEARNING_NODE"
  | "INVALID_LEARNING_GUIDE"
  | "INVALID_UNCERTAINTY"
  | "EMPTY_EXCERPT"
  | "MISMATCHED_FINGERPRINT";

export interface ThreadArtifactSuccess {
  readonly _tag: "success";
  readonly artifact: QuestionLearningThread;
}

export interface ThreadArtifactFailure {
  readonly _tag: "failure";
  readonly reason: ThreadArtifactFailureReason;
}

export type ThreadArtifactResult = ThreadArtifactSuccess | ThreadArtifactFailure;

// ── Ordering constants ────────────────────────────────────────────────────────

export const LEARNING_NODE_ORDER: readonly LearningNodeKind[] = [
  "relationship",
  "cause",
  "consensus",
  "evolution",
  "divergence",
  "changed_premise",
  "unknown",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const isValidThreadId = (value: string): boolean => value !== "" && /^[0-9a-f]{16}$/.test(value);

const normalizeText = (raw: string): string => {
  const nfc = raw.normalize("NFC");
  const lf = nfc.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return lf.trim();
};

const isValidLearningNodeKind = (value: unknown): value is LearningNodeKind =>
  typeof value === "string" &&
  (value === "relationship" ||
    value === "cause" ||
    value === "evolution" ||
    value === "consensus" ||
    value === "divergence" ||
    value === "changed_premise" ||
    value === "unknown");

const isValidUncertainty = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const isValidLearningGuideRole = (value: unknown): value is LearningGuideRole =>
  typeof value === "string" &&
  (value === "baseline" ||
    value === "correction" ||
    value === "extension" ||
    value === "counterpoint" ||
    value === "current_usage" ||
    value === "unclear");

const isValidZhihuUrl = (value: string): boolean =>
  value !== "" && /^https?:\/\/(www\.)?zhihu\.com\/question\/\d+\/answer\/\d+$/.test(value);

const isValidZhihuArticleUrl = (value: string): boolean =>
  value !== "" && /^https?:\/\/zhuanlan\.zhihu\.com\/p\/\d+$/.test(value);

// ── Sorting ──────────────────────────────────────────────────────────────────

export const sortLearningNodes = (nodes: readonly LearningNode[]): readonly LearningNode[] => {
  const orderMap = new Map<LearningNodeKind, number>();
  LEARNING_NODE_ORDER.forEach((kind, index) => orderMap.set(kind, index));

  return [...nodes].sort((a, b) => {
    const aOrder = orderMap.get(a.kind) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = orderMap.get(b.kind) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
};

// ── URL helpers ──────────────────────────────────────────────────────────────

export const extractZhihuQuestionId = (canonicalUrl: string): string | null => {
  const match = canonicalUrl.match(/\/question\/(\d+)\//);
  return match ? match[1] : null;
};

export const extractZhihuAnswerId = (canonicalUrl: string): string | null => {
  const match = canonicalUrl.match(/\/answer\/(\d+)$/);
  return match ? match[1] : null;
};

// ── Fingerprint ──────────────────────────────────────────────────────────────

export const buildThreadFingerprint = (
  question: string,
  refinedQuery: string,
  timelineStageCount: number,
  learningNodeCount: number,
  createdAt: number,
): string => {
  const material = [
    "question:" + question,
    "refinedQuery:" + refinedQuery,
    "timelineStages:" + String(timelineStageCount),
    "learningNodes:" + String(learningNodeCount),
    "createdAt:" + String(createdAt),
  ].join("\n");
  const [high, low] = fnv1a64(material);
  const hex = [high.toString(16).padStart(8, "0"), low.toString(16).padStart(8, "0")].join("");
  return `v1:${hex}`;
};

// ── Factory ──────────────────────────────────────────────────────────────────

const EXCERPT_BOUNDARY_NOTE = "这是摘录，不是完整回答";

const failure = (reason: ThreadArtifactFailureReason): ThreadArtifactFailure => ({
  _tag: "failure",
  reason,
});

const makeFallbackLearningGuide = (
  question: string,
  stages: readonly TimelineStage[],
  nodes: readonly LearningNode[],
): LearningGuide => buildDeterministicLearningGuide(question, stages, nodes);

const validateLearningGuide = (
  input: LearningGuideInput,
  stages: readonly TimelineStage[],
): LearningGuide | null => {
  const answerIdMap = new Map(stages.map((stage) => [stage.answerId, stage]));
  const excerptMap = new Map(
    stages.map((stage) => [stage.excerpt.fingerprint, stage.excerpt.excerpt]),
  );

  const validateEvidenceRefs = (refs: readonly EvidenceRefInput[]): EvidenceRef[] | null => {
    if (!Array.isArray(refs) || refs.length === 0) return null;
    const output: EvidenceRef[] = [];
    for (const ref of refs) {
      if (
        typeof ref !== "object" ||
        ref === null ||
        typeof ref.excerptFingerprint !== "string" ||
        typeof ref.quote !== "string"
      ) {
        return null;
      }
      const excerpt = excerptMap.get(ref.excerptFingerprint);
      const quote = normalizeText(ref.quote);
      if (!excerpt || quote === "" || !excerpt.includes(quote)) return null;
      output.push({ excerptFingerprint: ref.excerptFingerprint, quote });
    }
    return output;
  };

  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  if (
    typeof input.overview !== "object" ||
    input.overview === null ||
    typeof input.overview.headline !== "string" ||
    normalizeText(input.overview.headline) === "" ||
    typeof input.overview.summary !== "string" ||
    normalizeText(input.overview.summary) === ""
  ) {
    return null;
  }

  const overviewEvidence = validateEvidenceRefs(input.overview.evidenceRefs);
  if (!overviewEvidence) return null;

  if (!Array.isArray(input.stages) || input.stages.length !== stages.length) return null;
  const guideStages: LearningGuideStage[] = [];
  for (const stageInput of input.stages) {
    if (typeof stageInput !== "object" || stageInput === null) return null;
    const stage = answerIdMap.get(stageInput.answerId);
    if (
      !stage ||
      !isValidLearningGuideRole(stageInput.role) ||
      typeof stageInput.explanation !== "string" ||
      normalizeText(stageInput.explanation) === ""
    ) {
      return null;
    }
    const evidenceRefs = validateEvidenceRefs(stageInput.evidenceRefs);
    if (!evidenceRefs) return null;
    guideStages.push({
      answerId: stageInput.answerId,
      role: stageInput.role,
      explanation: normalizeText(stageInput.explanation),
      transition:
        typeof stageInput.transition === "string" && normalizeText(stageInput.transition) !== ""
          ? normalizeText(stageInput.transition)
          : undefined,
      evidenceRefs,
    });
  }

  if (!Array.isArray(input.openQuestions)) return null;
  const openQuestions = input.openQuestions
    .filter((question): question is string => typeof question === "string")
    .map(normalizeText)
    .filter((question) => question !== "");

  return {
    overview: {
      headline: normalizeText(input.overview.headline),
      summary: normalizeText(input.overview.summary),
      evidenceRefs: overviewEvidence,
    },
    stages: guideStages,
    openQuestions,
  };
};

export const createQuestionLearningThread = (input: ThreadArtifactInput): ThreadArtifactResult => {
  // 1. threadId

  if (!isValidThreadId(input.threadId)) {
    return failure("INVALID_THREAD_ID");
  }

  // 2. question

  if (typeof input.question !== "string") {
    return failure("EMPTY_QUESTION");
  }
  const question = normalizeText(input.question);
  if (question === "") {
    return failure("EMPTY_QUESTION");
  }

  // 3. refinedQuery

  if (typeof input.refinedQuery !== "string") {
    return failure("EMPTY_REFINED_QUERY");
  }
  const refinedQuery = normalizeText(input.refinedQuery);
  if (refinedQuery === "") {
    return failure("EMPTY_REFINED_QUERY");
  }

  // 4. createdAt

  if (
    typeof input.createdAt !== "number" ||
    !Number.isSafeInteger(input.createdAt) ||
    input.createdAt < 0
  ) {
    return failure("INVALID_CREATED_AT");
  }
  const createdAt = input.createdAt;

  // 5. timelineStages

  if (!Array.isArray(input.timelineStages) || input.timelineStages.length === 0) {
    return failure("EMPTY_TIMELINE");
  }

  const excerptFingerprints = new Map<string, string>();
  /**
   * Which answers or articles each excerpt fingerprint can belong to. A set is
   * required because the same excerpt text can be stored under two stages.
   */
  const excerptAnswerIds = new Map<string, Set<string>>();
  const timelineStages: TimelineStage[] = [];

  for (const raw of input.timelineStages) {
    if (
      typeof raw.answerId !== "string" ||
      !/^\d+$/.test(raw.answerId) ||
      typeof raw.questionId !== "string" ||
      (raw.questionId !== "" && !/^\d+$/.test(raw.questionId))
    ) {
      return failure("INVALID_TIMELINE_STAGE");
    }

    // title and author non-empty
    if (typeof raw.title !== "string" || normalizeText(raw.title) === "") {
      return failure("INVALID_TIMELINE_STAGE");
    }
    if (typeof raw.authorDisplayName !== "string" || normalizeText(raw.authorDisplayName) === "") {
      return failure("INVALID_TIMELINE_STAGE");
    }

    // editTime
    if (
      typeof raw.editTime !== "number" ||
      !Number.isSafeInteger(raw.editTime) ||
      raw.editTime < 0
    ) {
      return failure("INVALID_TIMELINE_STAGE");
    }

    // canonicalUrl
    if (
      typeof raw.canonicalUrl !== "string" ||
      (!isValidZhihuUrl(raw.canonicalUrl) && !isValidZhihuArticleUrl(raw.canonicalUrl))
    ) {
      return failure("INVALID_TIMELINE_STAGE");
    }

    // excerpt
    if (typeof raw.excerpt !== "object" || raw.excerpt === null || Array.isArray(raw.excerpt)) {
      return failure("INVALID_TIMELINE_STAGE");
    }
    if (typeof raw.excerpt.fingerprint !== "string" || raw.excerpt.fingerprint === "") {
      return failure("EMPTY_EXCERPT");
    }
    if (typeof raw.excerpt.excerpt !== "string" || normalizeText(raw.excerpt.excerpt) === "") {
      return failure("EMPTY_EXCERPT");
    }

    // Both kinds are summary-class evidence; anything else is out of scope.
    if (raw.excerpt.sourceContentType !== "Answer" && raw.excerpt.sourceContentType !== "Article") {
      return failure("INVALID_TIMELINE_STAGE");
    }

    const normalizedExcerpt = normalizeText(raw.excerpt.excerpt);
    excerptFingerprints.set(raw.excerpt.fingerprint, normalizedExcerpt);
    const answerIdsForFingerprint =
      excerptAnswerIds.get(raw.excerpt.fingerprint) ?? new Set<string>();
    answerIdsForFingerprint.add(raw.answerId);
    excerptAnswerIds.set(raw.excerpt.fingerprint, answerIdsForFingerprint);

    timelineStages.push({
      questionId: raw.questionId,
      answerId: raw.answerId,
      title: normalizeText(raw.title),
      authorDisplayName: normalizeText(raw.authorDisplayName),
      editTime: raw.editTime,
      canonicalUrl: raw.canonicalUrl,
      excerpt: Object.freeze({
        questionId: raw.excerpt.questionId,
        answerId: raw.excerpt.answerId,
        capturedAt: raw.excerpt.capturedAt,
        sourceContentId: raw.excerpt.sourceContentId,
        sourceContentType: raw.excerpt.sourceContentType,
        sourceEditTime: raw.excerpt.sourceEditTime,
        excerpt: normalizedExcerpt,
        fingerprint: raw.excerpt.fingerprint,
      }),
      excerptBoundaryNote: EXCERPT_BOUNDARY_NOTE,
    });
  }

  // 6. learningNodes

  if (!Array.isArray(input.learningNodes) || input.learningNodes.length === 0) {
    return failure("EMPTY_LEARNING_NODES");
  }

  const learningNodes: LearningNode[] = [];
  const answerIdMap = new Map(timelineStages.map((stage) => [stage.answerId, stage]));

  for (const raw of input.learningNodes) {
    // kind
    if (!isValidLearningNodeKind(raw.kind)) {
      return failure("INVALID_LEARNING_NODE");
    }

    // title
    if (typeof raw.title !== "string" || normalizeText(raw.title) === "") {
      return failure("INVALID_LEARNING_NODE");
    }

    // summary
    if (typeof raw.summary !== "string" || normalizeText(raw.summary) === "") {
      return failure("INVALID_LEARNING_NODE");
    }

    // evidenceRefs
    if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length === 0) {
      return failure("INVALID_LEARNING_NODE");
    }

    const evidenceRefs: EvidenceRef[] = [];
    for (const ref of raw.evidenceRefs) {
      if (
        typeof ref.excerptFingerprint !== "string" ||
        ref.excerptFingerprint === "" ||
        typeof ref.quote !== "string" ||
        normalizeText(ref.quote) === ""
      ) {
        return failure("INVALID_LEARNING_NODE");
      }
      const evidenceRefQuote = normalizeText(ref.quote);
      const sourceExcerpt = excerptFingerprints.get(ref.excerptFingerprint);
      if (!sourceExcerpt || !sourceExcerpt.includes(evidenceRefQuote)) {
        return failure("INVALID_LEARNING_NODE");
      }
      evidenceRefs.push({
        excerptFingerprint: ref.excerptFingerprint,
        quote: evidenceRefQuote,
      });
    }

    // sourceUrl
    // The node must point at a source we actually cited, and the URL shape
    // follows that source's kind: answer questions or column articles.
    const sourceStage = answerIdMap.get(raw.sourceAnswerId);
    const urlIsValid =
      typeof raw.sourceUrl === "string" && raw.sourceUrl === sourceStage?.canonicalUrl;
    if (!urlIsValid) {
      return failure("INVALID_LEARNING_NODE");
    }

    // uncertainty
    if (!isValidUncertainty(raw.uncertainty)) {
      return failure("INVALID_LEARNING_NODE");
    }

    if (!sourceStage) {
      return failure("INVALID_LEARNING_NODE");
    }

    // A node must quote the source it declares. Otherwise the artifact claims a
    // primary source that the node itself never cites.
    const citedAnswerIds = new Set<string>();
    for (const ref of evidenceRefs) {
      for (const answerId of excerptAnswerIds.get(ref.excerptFingerprint) ?? []) {
        citedAnswerIds.add(answerId);
      }
    }
    if (!citedAnswerIds.has(raw.sourceAnswerId)) {
      return failure("INVALID_LEARNING_NODE");
    }

    learningNodes.push({
      kind: raw.kind,
      title: normalizeText(raw.title),
      summary: normalizeText(raw.summary),
      evidenceRefs,
      sourceAnswerId: raw.sourceAnswerId,
      sourceUrl: raw.sourceUrl,
      uncertainty: raw.uncertainty,
    });
  }

  // 7. overall uncertainty

  if (!isValidUncertainty(input.uncertainty)) {
    return failure("INVALID_UNCERTAINTY");
  }

  // 8. learning guide: missing legacy guides get a safe deterministic bridge.
  const learningGuide =
    input.learningGuide === undefined
      ? makeFallbackLearningGuide(question, timelineStages, learningNodes)
      : validateLearningGuide(input.learningGuide, timelineStages);
  if (!learningGuide) {
    return failure("INVALID_LEARNING_GUIDE");
  }

  // 9. fingerprint

  const fingerprint = buildThreadFingerprint(
    question,
    refinedQuery,
    timelineStages.length,
    learningNodes.length,
    createdAt,
  );

  // ── assemble ────────────────────────────────────────────────────────────────

  const artifact: QuestionLearningThread = Object.freeze({
    threadId: input.threadId,
    question,
    refinedQuery,
    createdAt,
    timelineStages,
    learningNodes,
    learningGuide: Object.freeze(learningGuide),
    uncertainty: input.uncertainty,
    fingerprint,
  });

  return { _tag: "success", artifact };
};
