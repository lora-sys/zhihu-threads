/** Normalization boundary. Pure module, tested using the actual handlers' response contracts. */
import type { Artifact, Citation, Input, Observation, Port, Source, Unit } from "./types.ts";
import type { Network } from "./network.ts";
import type { Complete } from "./policy.ts";
import { makePolicy } from "./policy.ts";
import { EvalError } from "./runtime.ts";
export interface GenerateInput {
  question: string;
  refinedQuery: string;
  learningIntent: string;
  confidence: number;
  selectedCandidates: Array<{
    questionId: string;
    answerId: string;
    title: string;
    authorDisplayName: string;
    editTime: number;
    canonicalUrl: string;
    excerptFingerprint: string;
  }>;
}
export interface RankInput {
  question: string;
  refinedQuery: string;
  learningIntent: string;
  candidates: Array<{
    answerId: string;
    title: string;
    authorDisplayName: string;
    preview: string;
  }>;
}
export interface Bindings {
  seed: (input: Input) => Promise<void>;
  clarify: (input: {
    question: string;
  }) => Promise<unknown>;
  search: (input: {
    query: string;
    altQueries?: string[];
  }) => Promise<unknown>;
  rank: (input: RankInput) => Promise<unknown>;
  generate: (input: GenerateInput) => Promise<unknown>;
  read: (input: {
    threadId: string;
  }) => Promise<unknown>;
  ask: (input: {
    threadId: string;
    question: string;
    conversation: Array<{
      role: "user" | "assistant";
      content: string;
    }>;
  }) => Promise<unknown>;
  excerpt: (questionId: string, answerId: string) => Promise<unknown>;
  diagnostics: string[];
}
export const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new EvalError("INVALID_PRODUCT_OBJECT");
  return v as Record<string, unknown>;
};
export const str = (v: unknown): string => {
  if (typeof v !== "string")
    throw new EvalError("INVALID_PRODUCT_TEXT");
  return v;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v))
    throw new EvalError("INVALID_PRODUCT_LIST");
  return v;
};
const num = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new EvalError("INVALID_PRODUCT_NUMBER");
  return v;
};
const citation = (v: unknown, sources: Source[]): Citation => {
  const r = obj(v);
  const fingerprint = str(r.excerptFingerprint);
  const source = sources.find((s) => s.fingerprint === fingerprint);
  // Guide/node schemas contain only a fingerprint. Resolve the corresponding identity.
  // Explicit identities on Agent references must be preserved, not silently repaired.
  return { sourceId: typeof r.answerId === "string" ? r.answerId : source?.id ?? "unknown",
    fingerprint, quote: str(r.quote), url: typeof r.sourceUrl === "string" ? r.sourceUrl : source?.url ?? "unknown",
    ...(typeof r.authorDisplayName === "string" ? { author: r.authorDisplayName } : {}) };
};
export const normalizeArtifact = (raw: unknown, mode: Artifact["mode"]): Artifact => {
  const value = obj(raw);
  const sources: Source[] = list(value.timelineStages).map((v) => {
    const stage = obj(v);
    const e = obj(stage.excerpt);
    const kind = str(e.sourceContentType);
    if (kind !== "Answer" && kind !== "Article")
      throw new EvalError("INVALID_SOURCE_KIND");
    return { id: str(stage.answerId), fingerprint: str(e.fingerprint), text: str(e.excerpt), url: str(stage.canonicalUrl), author: str(stage.authorDisplayName), kind,
      questionId: str(stage.questionId), title: str(stage.title), editTime: num(stage.editTime), capturedAt: num(e.capturedAt), contentId: str(e.sourceContentId) };
  });
  const units: Unit[] = list(value.learningNodes).map((v, index) => {
    const node = obj(v);
    return { id: `node-${index}`, kind: "claim", text: `${str(node.title)}\n${str(node.summary)}`,
      citations: list(node.evidenceRefs).map((ref) => citation(ref, sources)),
      primarySource: { id: str(node.sourceAnswerId), url: str(node.sourceUrl) } };
  });
  const guide = obj(value.learningGuide);
  const overview = obj(guide.overview);
  units.push({ id: "guide-overview", kind: "claim", text: `${str(overview.headline)}\n${str(overview.summary)}`,
    citations: list(overview.evidenceRefs).map((ref) => citation(ref, sources)) });
  for (const [index, v] of list(guide.stages).entries()) {
    const stage = obj(v);
    units.push({ id: `guide-stage-${index}`, kind: "claim", text: [str(stage.explanation), typeof stage.transition === "string" ? stage.transition : ""].filter(Boolean).join("\n"),
      citations: list(stage.evidenceRefs).map((ref) => citation(ref, sources)) });
  }
  return { id: str(value.threadId), mode, sources, units };
};
export const createBridge = (bindings: Bindings, network: Network, complete: Complete, fixtureFetch?: typeof fetch): Port => {
  let seeded = false;
  let refinedQuery = "";
  let intent = "";
  let alternatives: string[] = [];
  const modes = new Map<string, Artifact["mode"]>();
  const failure = (value: Record<string, unknown>): Observation => ({
    status: "error", code: typeof value.code === "string" ? value.code : "PRODUCT_ERROR",
    retryable: /HTTP_STATUS:(429|5\d\d)|NETWORK_FAILED|TRANSPORT_FAILED|SEARCH_RATE_LIMITED/.test([...bindings.diagnostics, String(value.code)].join(" ")),
    message: typeof value.message === "string" ? value.message : "Product operation failed",
  });
  return {
    decide: makePolicy(complete),
    invoke: (action, view, runtime) => network.scope(runtime, "product", async () => {
      bindings.diagnostics.length = 0;
      if (!seeded) {
        await bindings.seed(view.input);
        seeded = true;
        if (view.input.artifact)
          modes.set(view.input.artifact.id, view.input.artifact.mode);
      }
      const question = view.input.question;
      const query = action.query ?? (refinedQuery || question);
      if (action.tool === "clarify") {
        const r = obj(await bindings.clarify({ question }));
        if (r.success !== true) {
          if (bindings.diagnostics.some((e) => e.includes("REFUSED_QUESTION")))
            return { status: "refused", message: str(r.message) };
          return failure(r);
        }
        refinedQuery = str(r.refinedQuery);
        intent = str(r.learningIntent);
        alternatives = list(r.alternatives).map(str);
        return { status: "ok", query: refinedQuery, units: [{ id: "clarification", kind: "guidance", text: `${intent}\n${str(r.guidance)}`, citations: [] }] };
      }
      if (action.tool === "search") {
        const r = obj(await bindings.search({ query, altQueries: alternatives }));
        if (r.status !== "ok")
          return failure(r);
        const sources: Source[] = [];
        for (const v of list(r.candidates)) {
          const c = obj(v);
          const e = obj(await bindings.excerpt(str(c.questionId), str(c.answerId)));
          if (e.fingerprint !== c.excerptFingerprint)
            throw new EvalError("EXCERPT_VERSION_MISMATCH");
          const kind = str(c.sourceContentType);
          if (kind !== "Answer" && kind !== "Article")
            throw new EvalError("INVALID_SOURCE_KIND");
          sources.push({ id: str(c.answerId), questionId: str(c.questionId), fingerprint: str(e.fingerprint), text: str(e.excerpt), url: str(c.url),
            author: typeof c.authorDisplayName === "string" ? c.authorDisplayName : "知乎用户", kind,
            title: str(c.title), editTime: typeof c.editAt === "number" ? c.editAt : 0, capturedAt: num(e.capturedAt), contentId: str(e.sourceContentId) });
        }
        return { status: "ok", sources };
      }
      if (action.tool === "rank") {
        const r = obj(await bindings.rank({ question, refinedQuery: refinedQuery || question, learningIntent: intent || view.input.learningTask || question,
          candidates: view.sources.map((s) => ({ answerId: s.id, title: s.title || question, authorDisplayName: s.author ?? "知乎用户", preview: s.text.slice(0, 200) })) }));
        if (r.success !== true)
          return failure(r);
        const analysis = obj(r.analysis);
        const rankings = list(analysis.rankings).map(obj);
        const priority = ["baseline", "correction", "counterpoint"];
        rankings.sort((a, b) => Number(priority.includes(str(b.role))) - Number(priority.includes(str(a.role))));
        return { status: "ok", rankedIds: rankings.map((r) => str(r.answerId)), units: [
            { id: "ranking-summary", kind: "guidance", text: str(analysis.summary), citations: [] },
            ...rankings.map((r, index) => ({ id: `ranking-${index}`, kind: "guidance" as const, text: str(r.reason), citations: [] })),
          ] };
      }
      if (action.tool === "generate") {
        const selected = (action.sourceIds ?? []).map((id) => view.sources.find((s) => s.id === id)!);
        const r = obj(await bindings.generate({ question, refinedQuery: refinedQuery || question, learningIntent: intent || view.input.learningTask || question, confidence: 0.5,
          selectedCandidates: selected.map((s) => ({ questionId: s.questionId ?? "", answerId: s.id, title: s.title || question,
            authorDisplayName: s.author ?? "知乎用户", editTime: s.editTime ?? 0, canonicalUrl: s.url, excerptFingerprint: s.fingerprint })) }));
        if (r.success !== true)
          return failure(r);
        const id = str(r.threadId);
        if (r.mode !== "synthesized" && r.mode !== "evidence_only")
          throw new EvalError("INVALID_GENERATION_MODE");
        modes.set(id, r.mode);
        // The product returns an id, so obtain the actual persisted result before grading.
        const loaded = obj(await bindings.read({ threadId: id }));
        if (loaded.success !== true)
          return failure(loaded);
        return { status: "ok", artifact: normalizeArtifact(loaded.artifact, r.mode) };
      }
      if (action.tool === "read") {
        const r = obj(await bindings.read({ threadId: view.artifact?.id ?? "" }));
        return r.success === true ? { status: "ok", artifact: normalizeArtifact(r.artifact, modes.get(view.artifact!.id) ?? "evidence_only") } : failure(r);
      }
      if (action.tool === "ask") {
        const r = obj(await bindings.ask({ threadId: view.artifact?.id ?? "", question: query,
          conversation: view.turns.flatMap((t) => [{ role: "user" as const, content: t.question }, { role: "assistant" as const, content: t.answer.text }]) }));
        if (r.success !== true)
          return failure(r);
        const a = obj(r.response);
        if (a.status !== "grounded" && a.status !== "evidence_gap")
          throw new EvalError("INVALID_AGENT_STATUS");
        return { status: "ok", answer: { status: a.status === "grounded" ? "answered" : "evidence_gap", text: str(a.answer),
            citations: list(a.evidenceRefs).map((ref) => citation(ref, view.artifact?.sources ?? [])),
            nextQueries: list(a.nextActions).map(obj).filter((a) => a.type === "search_supplement" && typeof a.query === "string").map((a) => str(a.query)) } };
      }
      throw new EvalError("UNSUPPORTED_PRODUCT_ACTION");
    }, fixtureFetch),
  };
};
