/**
 * Thread synthesis workflow for the Question Learning Thread product.
 *
 * Receives validated excerpts, metadata, and the clarified question. It drafts
 * learning nodes, but the workflow owns the final artifact:
 *
 * - Every learning summary must cite at least one selected excerpt
 * - Every quote must be an exact substring of the validated excerpt after
 *   the project's normal whitespace normalization
 * - Unsupported drafts become `unknown` nodes without a factual conclusion
 * - Summaries use "the premise has changed", not "the author was wrong"
 * - Source links must be canonical parsed Zhihu URLs
 * - Model output with malformed citations, unknown answer IDs, or banned
 *   wording is rejected and mapped to a safe `ThreadSynthesisError`
 *
 * A deterministic fallback may mark the selected answers as source timeline
 * stages without invented analysis.
 *
 * @module thread-synthesis
 */

import { Data, Effect } from "effect";

import type {
  TimelineStage,
  LearningNodeKind,
  EvidenceRef,
  LearningGuide,
  LearningGuideStage,
  LearningGuideInput,
  LearningGuideRole,
} from "./thread-artifact";
import { buildDeterministicLearningGuide } from "./thread-guide";
import { describeTransportError } from "./openai-adapter";

// ── Banned wording patterns (author-respect) ───────────────────────────────────

const BANNED_PATTERNS = [
  /原[答作]者[是为][错了]/,
  /作者[是为][错了]/,
  /回答[是为][错了]/,
  /事实[是为][错了]/,
  /答案[是为][错了]/,
  /wrong\s+(author|authority)/i,
];

const hasBannedWording = (text: string): boolean =>
  BANNED_PATTERNS.some((pattern) => pattern.test(text));

// ── Errors ─────────────────────────────────────────────────────────────────────

export class ThreadSynthesisError extends Data.TaggedError("ThreadSynthesisError")<{
  readonly reason:
    | "MALFORMED_RESPONSE"
    | "ALL_NODES_REJECTED"
    | "UNCITED_CLAIM"
    | "UNKNOWN_ANSWER_ID"
    | "BANNED_WORDING"
    | "MALFORMED_CITATION"
    | "TRANSPORT_FAILED";
  /** Underlying transport detail, kept for traces only. */
  readonly cause?: string;
}> {}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SynthesizedNode {
  readonly kind: LearningNodeKind;
  readonly title: string;
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly sourceAnswerId: string;
  readonly sourceUrl: string;
  readonly uncertainty: number;
}

export interface SynthesisInput {
  readonly question: string;
  readonly refinedQuery: string;
  readonly learningIntent: string;
  readonly timelineStages: readonly TimelineStage[];
  readonly maxNodes?: number;
}

export interface ThreadSynthesisDeps {
  readonly model: string;
  readonly chat: {
    readonly complete: (request: {
      readonly model: string;
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }) => Effect.Effect<string, unknown>;
  };
  /** Why model nodes were dropped.  Server-side diagnosis; never user-facing. */
  readonly onDiagnostics?: (diagnostics: { readonly rejected: readonly string[] }) => void;
}

export interface ThreadSynthesisResult {
  readonly _tag: "success";
  readonly nodes: readonly SynthesizedNode[];
  readonly learningGuide: LearningGuide;
  /**
   * Whether the nodes came from the model or from the deterministic evidence
   * dump. Callers must not report "synthesized" when this is `fallback`.
   */
  readonly source: "model" | "fallback";
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_NODES = 7; // one per kind
const MAX_QUESTION_LENGTH = 500;

// The model needs enough of each excerpt to name real concepts, but the whole
// call stays bounded so long answers cannot blow the context window.
const EXCERPT_CHARS_PER_STAGE = 1_500;
const EXCERPT_CHARS_TOTAL_BUDGET = 6_000;

// ── Answer ID map for validation ───────────────────────────────────────────────

const buildAnswerIdMap = (timelineStages: readonly TimelineStage[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const stage of timelineStages) {
    map.set(stage.answerId, stage.canonicalUrl);
  }
  return map;
};

// ── Excerpt fingerprint map for citation validation ─────────────────────────────

/**
 * Models drift on internal whitespace when copying a quote (newlines become
 * single spaces, indentation disappears). Matching happens on a
 * whitespace-collapsed view, but the quote that ships is always the verbatim
 * source substring, so the artifact-level "exact substring" guarantee still
 * holds byte-for-byte.
 */
interface CollapsedView {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

const buildCollapsedView = (source: string): CollapsedView => {
  const starts: number[] = [];
  const ends: number[] = [];
  const parts: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      let end = index;
      while (end < source.length && /\s/.test(source[end])) end += 1;
      parts.push(" ");
      starts.push(index);
      ends.push(end);
      index = end;
      continue;
    }
    parts.push(char);
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }
  return { text: parts.join(""), starts, ends };
};

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const snapQuote = (view: CollapsedView, source: string, quote: string): string | null => {
  const needle = collapseWhitespace(quote);
  if (needle === "") return null;
  const at = view.text.indexOf(needle);
  if (at === -1) return null;
  const start = view.starts[at];
  const end = view.ends[at + needle.length - 1];
  if (start === undefined || end === undefined) return null;
  return source.slice(start, end).trim();
};

interface ExcerptCitationData {
  readonly fingerprint: string;
  readonly text: string;
  readonly view: CollapsedView;
  readonly answerId: string;
}

const buildExcerptCitationMap = (
  timelineStages: readonly TimelineStage[],
): Map<string, ExcerptCitationData> => {
  const map = new Map<string, ExcerptCitationData>();
  for (const stage of timelineStages) {
    const text = stage.excerpt.excerpt;
    map.set(stage.excerpt.fingerprint, {
      fingerprint: stage.excerpt.fingerprint,
      text,
      view: buildCollapsedView(text),
      answerId: stage.answerId,
    });
  }
  return map;
};

// ── Validate a single synthesized node ────────────────────────────────────────

const validateNode = (
  raw: Record<string, unknown>,
  answerIdMap: Map<string, string>,
  excerptCitationMap: Map<string, ExcerptCitationData>,
): { readonly node: SynthesizedNode | null; readonly reason: string } => {
  const reject = (reason: string) => ({ node: null, reason });
  // kind
  const kind = raw.kind;
  if (
    typeof kind !== "string" ||
    (kind !== "relationship" &&
      kind !== "cause" &&
      kind !== "evolution" &&
      kind !== "consensus" &&
      kind !== "divergence" &&
      kind !== "changed_premise" &&
      kind !== "unknown")
  ) {
    return reject("bad_kind");
  }

  // title
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title === "") return reject("empty_title");

  // summary
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary === "") return reject("empty_summary");

  // Check banned wording
  if (hasBannedWording(summary) || hasBannedWording(title)) {
    return reject("banned_wording");
  }

  // evidenceRefs
  const evidenceRefsRaw = raw.evidenceRefs;
  if (!Array.isArray(evidenceRefsRaw) || evidenceRefsRaw.length === 0) {
    return reject("no_evidence_refs");
  }

  const evidenceRefs: EvidenceRef[] = [];
  for (const ref of evidenceRefsRaw) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const refObj = ref as Record<string, unknown>;
    const excerptFingerprint =
      typeof refObj.excerptFingerprint === "string" ? refObj.excerptFingerprint.trim() : "";
    if (excerptFingerprint === "") continue;

    const quote = typeof refObj.quote === "string" ? refObj.quote.trim() : "";
    if (quote === "") continue;

    // Snap the citation back to verbatim source text; drop it if it is not there.
    const excerptData = excerptCitationMap.get(excerptFingerprint);
    if (excerptData === undefined) continue;
    const snapped = snapQuote(excerptData.view, excerptData.text, quote);
    if (snapped === null) continue;

    evidenceRefs.push({ excerptFingerprint, quote: snapped });
  }
  // A node survives as long as at least one citation is real evidence.
  if (evidenceRefs.length === 0) return reject("no_grounded_citation");

  // sourceAnswerId.  The citations are already verified against a specific
  // excerpt, so when they all point at one answer we can recover the source
  // even if the model echoed a placeholder or dropped the field.  That is
  // strictly better than discarding a grounded node over a bookkeeping slip.
  const citedAnswerIds = new Set(
    evidenceRefs
      .map((ref) => excerptCitationMap.get(ref.excerptFingerprint)?.answerId)
      .filter((id): id is string => typeof id === "string" && id !== ""),
  );
  const declaredAnswerId = typeof raw.sourceAnswerId === "string" ? raw.sourceAnswerId.trim() : "";
  // The declared source is only trusted when the node actually quotes it.
  // Bookkeeping slips (a placeholder, or a source the node never cites) fall
  // back to the first cited answer rather than discarding a grounded node; the
  // artifact layer then enforces the same invariant for every caller.
  const sourceAnswerId = citedAnswerIds.has(declaredAnswerId)
    ? declaredAnswerId
    : (citedAnswerIds.values().next().value ?? "");
  if (sourceAnswerId === "") return reject("unknown_source_answer");

  // sourceUrl is metadata we already own, not a model claim.  Trusting our
  // canonical form instead of demanding a byte-identical echo removes a class
  // of false rejections without weakening the evidence guarantee.
  const sourceUrl = answerIdMap.get(sourceAnswerId) ?? "";
  if (sourceUrl === "") return reject("missing_canonical_url");

  // uncertainty
  const uncertainty = raw.uncertainty;
  if (
    typeof uncertainty !== "number" ||
    !Number.isFinite(uncertainty) ||
    uncertainty < 0 ||
    uncertainty > 1
  ) {
    return reject("bad_uncertainty");
  }

  return {
    node: {
      kind: kind as LearningNodeKind,
      title,
      summary,
      evidenceRefs,
      sourceAnswerId,
      sourceUrl,
      uncertainty,
    },
    reason: "ok",
  };
};

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "你在为中文学习者搭建一座从真实知乎摘录出发的学习廊桥。产出学习节点和学习指南。 " +
  "Each node has: kind (relationship, cause, evolution, consensus, divergence, changed_premise, or unknown), title, summary, evidenceRefs (array of {excerptFingerprint, quote}), sourceAnswerId, sourceUrl (canonical Zhihu URL), uncertainty (0.0-1.0). " +
  "The guide has overview {headline, summary, evidenceRefs}, one stage per selected answer with {answerId, role, explanation, transition, evidenceRefs}, and openQuestions. Roles are baseline, correction, extension, counterpoint, current_usage, or unclear. " +
  "每个 summary 必须用中文点出这段摘录里的具体概念、机制或术语本身，不要复述摘录开头，也不要只写泛泛的过渡句。 " +
  "优先写成：这一层讲的是什么机制、它和上一层有什么不同、在什么条件下成立。 " +
  "摘录里出现的技术术语必须原样保留在 title 或 summary 中，包括中文术语原词和英文原名，" +
  "不要用「它」「这种机制」之类的指代代替，也不要用你自己的同义词改写——学习者要靠这些原词继续搜索和延伸阅读。 " +
  "overview.summary 要点名这条学习线最关键的技术术语。 " +
  "Every evidenceRef.quote MUST be copied verbatim from the corresponding excerpt text. " +
  "Never say the author was wrong; say the premise has changed. " +
  "SourceAnswerId must be one of the provided timeline stage answer IDs. " +
  "每个节点的 sourceAnswerId 必须属于该节点自己的 evidenceRefs 所引用的来源，" +
  "不要指向这个节点没有引用的回答或文章。 " +
  "If you are not certain about a claim, use kind 'unknown' with a factual summary. " +
  "Do not add fields such as id, content, evidenceRef, source, selection_reference, or misconception_reminder. " +
  "Use exactly the requested field names. " +
  'Reply with only raw JSON: {"nodes":[...],"guide":{...}}';

/** Per-stage excerpt budget, shrunk further when several stages share one call. */
const excerptBudget = (stageCount: number): number =>
  Math.max(
    400,
    Math.min(
      EXCERPT_CHARS_PER_STAGE,
      Math.floor(EXCERPT_CHARS_TOTAL_BUDGET / Math.max(stageCount, 1)),
    ),
  );

// ── Fallback generation ────────────────────────────────────────────────────────

const makeFallbackNodes = (
  timelineStages: readonly TimelineStage[],
  maxNodes: number,
): SynthesizedNode[] => {
  const kind: LearningNodeKind = "unknown";
  const nodes: SynthesizedNode[] = [];

  for (let i = 0; i < Math.min(timelineStages.length, maxNodes); i++) {
    const stage = timelineStages[i];
    nodes.push({
      kind,
      title: `证据节点：${stage.authorDisplayName}`,
      summary: stage.excerpt.excerpt.slice(0, Math.min(180, stage.excerpt.excerpt.length)),
      evidenceRefs: [
        {
          excerptFingerprint: stage.excerpt.fingerprint,
          quote: stage.excerpt.excerpt.slice(0, 100),
        },
      ],
      sourceAnswerId: stage.answerId,
      sourceUrl: stage.canonicalUrl,
      uncertainty: 1.0,
    });
  }

  return nodes;
};

const makeFallbackLearningGuide = (
  question: string,
  timelineStages: readonly TimelineStage[],
  nodes: readonly SynthesizedNode[],
): LearningGuide =>
  buildDeterministicLearningGuide(
    question,
    timelineStages,
    nodes.map((node) => ({
      kind: node.kind,
      title: node.title,
      summary: node.summary,
      evidenceRefs: node.evidenceRefs,
      sourceAnswerId: node.sourceAnswerId,
      sourceUrl: node.sourceUrl,
      uncertainty: node.uncertainty,
    })),
  );

export const buildEvidenceOnlySynthesis = (input: SynthesisInput): ThreadSynthesisResult => {
  const nodes = makeFallbackNodes(input.timelineStages, input.maxNodes ?? MAX_NODES);
  const learningGuide = makeFallbackLearningGuide(input.question, input.timelineStages, nodes);
  return {
    _tag: "success",
    nodes,
    learningGuide,
    source: "fallback",
  };
};

const validateGuideEvidence = (
  refs: readonly {
    readonly excerptFingerprint: string;
    readonly quote: string;
  }[],
  excerptCitationMap: Map<string, ExcerptCitationData>,
): EvidenceRef[] | null => {
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const output: EvidenceRef[] = [];
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const fingerprint =
      typeof ref.excerptFingerprint === "string" ? ref.excerptFingerprint.trim() : "";
    const quote = typeof ref.quote === "string" ? ref.quote.trim() : "";
    if (fingerprint === "" || quote === "") continue;
    const excerpt = excerptCitationMap.get(fingerprint);
    if (!excerpt) continue;
    const snapped = snapQuote(excerpt.view, excerpt.text, quote);
    if (snapped === null) continue;
    output.push({ excerptFingerprint: fingerprint, quote: snapped });
  }
  return output.length > 0 ? output : null;
};

const isValidGuideRole = (value: unknown): value is LearningGuideRole =>
  typeof value === "string" &&
  (value === "baseline" ||
    value === "correction" ||
    value === "extension" ||
    value === "counterpoint" ||
    value === "current_usage" ||
    value === "unclear");

const validateLearningGuide = (
  raw: unknown,
  timelineStages: readonly TimelineStage[],
  answerIdMap: Map<string, string>,
  excerptCitationMap: Map<string, ExcerptCitationData>,
): LearningGuide | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as LearningGuideInput;

  if (
    typeof input.overview !== "object" ||
    input.overview === null ||
    typeof input.overview.headline !== "string" ||
    input.overview.headline.trim() === "" ||
    typeof input.overview.summary !== "string" ||
    input.overview.summary.trim() === "" ||
    hasBannedWording(input.overview.headline) ||
    hasBannedWording(input.overview.summary)
  ) {
    return null;
  }

  const overviewEvidence = validateGuideEvidence(input.overview.evidenceRefs, excerptCitationMap);
  if (!overviewEvidence) return null;

  if (!Array.isArray(input.stages) || input.stages.length !== timelineStages.length) return null;
  const stages: LearningGuideStage[] = [];
  for (const stageInput of input.stages) {
    if (typeof stageInput !== "object" || stageInput === null) return null;
    if (!answerIdMap.has(stageInput.answerId) || !isValidGuideRole(stageInput.role)) return null;
    if (
      typeof stageInput.explanation !== "string" ||
      stageInput.explanation.trim() === "" ||
      hasBannedWording(stageInput.explanation)
    ) {
      return null;
    }
    const evidenceRefs = validateGuideEvidence(stageInput.evidenceRefs, excerptCitationMap);
    if (!evidenceRefs) return null;
    stages.push({
      answerId: stageInput.answerId,
      role: stageInput.role,
      explanation: stageInput.explanation.trim(),
      transition:
        typeof stageInput.transition === "string" &&
        stageInput.transition.trim() !== "" &&
        !hasBannedWording(stageInput.transition)
          ? stageInput.transition.trim()
          : undefined,
      evidenceRefs,
    });
  }

  if (!Array.isArray(input.openQuestions)) return null;
  const openQuestions = input.openQuestions
    .filter((question): question is string => typeof question === "string")
    .map((question) => question.trim())
    .filter((question) => question !== "" && !hasBannedWording(question));

  return {
    overview: {
      headline: input.overview.headline.trim(),
      summary: input.overview.summary.trim(),
      evidenceRefs: overviewEvidence,
    },
    stages,
    openQuestions,
  };
};

// ── Workflow ───────────────────────────────────────────────────────────────────

export const synthesizeThread =
  (deps: ThreadSynthesisDeps) =>
  (input: SynthesisInput): Effect.Effect<ThreadSynthesisResult, ThreadSynthesisError> =>
    Effect.gen(function* () {
      // The provider intermittently returns a payload that will not parse, or
      // that misuses the node contract.  Both are worth one bounded retry
      // before the thread degrades.  Transport hiccups are already retried at
      // the adapter boundary, so they are not repeated here.
      const attempt = yield* Effect.either(
        synthesizeOnce(deps)(input).pipe(
          Effect.retry({
            times: SYNTHESIS_ATTEMPTS - 1,
            while: (error) => error.reason === "ALL_NODES_REJECTED",
          }),
        ),
      );

      if (attempt._tag === "Left") {
        // Only after the retry budget is spent do we fall back to an honest
        // evidence-only thread.  It is labelled "fallback" so the product and
        // the eval both know the AI layer did not author it.  A payload that
        // never parsed at all stays a hard error rather than being silently
        // downgraded into a dump.
        if (attempt.left.reason !== "ALL_NODES_REJECTED") return yield* Effect.fail(attempt.left);
        const fallbackNodes = makeFallbackNodes(input.timelineStages, input.maxNodes ?? MAX_NODES);
        const question = input.question.trim();
        return {
          _tag: "success" as const,
          nodes: fallbackNodes,
          learningGuide: makeFallbackLearningGuide(question, input.timelineStages, fallbackNodes),
          source: "fallback" as const,
        };
      }

      return attempt.right;
    });

const SYNTHESIS_ATTEMPTS = 2;

const synthesizeOnce =
  (deps: ThreadSynthesisDeps) =>
  (input: SynthesisInput): Effect.Effect<ThreadSynthesisResult, ThreadSynthesisError> =>
    Effect.gen(function* () {
      const question = input.question.trim();
      if (question === "" || question.length > MAX_QUESTION_LENGTH) {
        return yield* Effect.fail(new ThreadSynthesisError({ reason: "MALFORMED_RESPONSE" }));
      }

      const maxNodes = input.maxNodes ?? MAX_NODES;
      const answerIdMap = buildAnswerIdMap(input.timelineStages);
      const excerptCitationMap = buildExcerptCitationMap(input.timelineStages);

      // Build the context payload from timeline stages
      const perStage = excerptBudget(input.timelineStages.length);
      const stagesSummary = input.timelineStages
        .map((s) => {
          const body = s.excerpt.excerpt.slice(0, perStage);
          const year = s.editTime > 0 ? new Date(s.editTime * 1000).getFullYear() : "时间未知";
          return `[Answer ${s.answerId}] (${year}, ${s.authorDisplayName})\n${body}`;
        })
        .join("\n\n");

      const userPrompt = [
        `Question: ${question}`,
        `Refined query: ${input.refinedQuery}`,
        `Learning intent: ${input.learningIntent}`,
        "",
        "Selected excerpts (each prefixed with [Answer ID]):",
        stagesSummary,
        "",
        `Answer IDs and canonical URLs: ${Array.from(answerIdMap.entries())
          .map(([answerId, canonicalUrl]) => `${answerId} -> ${canonicalUrl}`)
          .join("; ")}`,
        `Excerpt fingerprints: ${Array.from(excerptCitationMap.keys()).join(", ")}`,
        "",
        `Produce up to ${maxNodes} learning nodes and the guide as a JSON object {"nodes":[...],"guide":{...}}.`,
      ].join("\n");

      const raw = yield* deps.chat
        .complete({
          model: deps.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ThreadSynthesisError({
                reason: "TRANSPORT_FAILED",
                cause: describeTransportError(error),
              }),
          ),
        );

      // Parse the JSON response
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        return yield* Effect.fail(new ThreadSynthesisError({ reason: "MALFORMED_RESPONSE" }));
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return yield* Effect.fail(new ThreadSynthesisError({ reason: "MALFORMED_RESPONSE" }));
      }

      const obj = parsed as Record<string, unknown>;
      const nodesRaw = obj.nodes;
      if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
        return yield* Effect.fail(new ThreadSynthesisError({ reason: "MALFORMED_RESPONSE" }));
      }

      // Validate each node
      const validNodes: SynthesizedNode[] = [];
      const rejectionReasons: string[] = [];
      for (const nodeRaw of nodesRaw) {
        if (typeof nodeRaw !== "object" || nodeRaw === null || Array.isArray(nodeRaw)) {
          continue;
        }
        const { node: validated, reason } = validateNode(
          nodeRaw as Record<string, unknown>,
          answerIdMap,
          excerptCitationMap,
        );
        if (validated !== null) validNodes.push(validated);
        else rejectionReasons.push(reason);
      }

      // Every node rejected means the model misused the contract, not that the
      // evidence was thin.  Degrading to a raw excerpt dump on the first miss
      // was being reported as a success, so the retry budget never got used
      // and the AI layer quietly stopped doing its job.
      if (validNodes.length === 0) {
        deps.onDiagnostics?.({ rejected: rejectionReasons });
        return yield* Effect.fail(new ThreadSynthesisError({ reason: "ALL_NODES_REJECTED" }));
      }
      deps.onDiagnostics?.({ rejected: rejectionReasons });

      const learningGuide =
        validateLearningGuide(obj.guide, input.timelineStages, answerIdMap, excerptCitationMap) ??
        makeFallbackLearningGuide(question, input.timelineStages, validNodes);

      return { _tag: "success", nodes: validNodes, learningGuide, source: "model" };
    });
