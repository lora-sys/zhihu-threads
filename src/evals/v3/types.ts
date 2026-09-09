/** Execution contracts contain no grading labels. Sources are immutable snapshots. */
export type Mode = "single_step" | "workflow" | "multi_turn" | "autonomous";
export type Purpose = "capability" | "regression";
export type Tool = "clarify" | "search" | "rank" | "generate" | "read" | "ask";
export type Outcome = "completed" | "refused" | "evidence_gap" | "error" | "budget_exceeded";
export type Verdict = "pass" | "fail" | "unjudged";
export type Phase = "product" | "planner" | "judge";
export interface Source {
  id: string;
  fingerprint: string;
  text: string;
  url: string;
  author: string | null;
  kind?: "Answer" | "Article" | "fixture";
  questionId?: string;
  contentId?: string;
  capturedAt?: number;
  editTime?: number;
  title?: string;
}
export interface Citation {
  sourceId: string;
  fingerprint: string;
  quote: string;
  url: string;
  author?: string;
}
export interface Unit {
  id: string;
  text: string;
  citations: Citation[];
  kind: "claim" | "boundary" | "guidance";
  primarySource?: {
    id: string;
    url: string;
  };
}
export interface Artifact {
  id: string;
  mode: "synthesized" | "evidence_only";
  sources: Source[];
  units: Unit[];
}
export interface Answer {
  status: "answered" | "evidence_gap" | "refused";
  text: string;
  citations: Citation[];
  nextQueries: string[];
}
export interface Action {
  tool: Tool | "finish" | "refuse";
  query?: string;
  sourceIds?: string[];
  message?: string;
}
export interface Observation {
  status: "ok" | "error" | "refused" | "evidence_gap";
  code?: string;
  retryable?: boolean;
  message?: string;
  query?: string;
  sources?: Source[];
  rankedIds?: string[];
  artifact?: Artifact;
  answer?: Answer;
  /** Actual visible model explanations, not serialized transport JSON. */
  units?: Unit[];
}
export interface Input {
  question: string;
  learningTask?: string;
  followUps?: string[];
  sources?: Source[];
  artifact?: Artifact;
  /** Explicit simulated user choices; not copied from expected. */
  selectedSourceIds?: string[];
  step?: Action;
}
export interface Expected {
  outcomes: Outcome[];
  allowedErrorCodes?: string[];
  minSources?: number;
  concepts?: string[][];
  forbiddenText?: string[];
  requiredTools?: Tool[];
  forbiddenTools?: Tool[];
  synthesis?: boolean;
  citations?: boolean;
  answerability?: Array<"answerable" | "insufficient" | "unsafe" | "unknown">;
  supplement?: boolean;
}
export interface Task {
  id: string;
  title: string;
  purpose: Purpose;
  mode: Mode;
  input: Input;
  expected: Expected;
  regression?: {
    contract: string;
    affectedPaths: string[];
  };
}
export interface Step {
  index: number;
  action: Action;
  observation: Observation;
  durationMs: number;
  /** Trusted tool evidence at this moment, not the model's claimed evidence. */
  available: Source[];
}
export interface Turn {
  question: string;
  answer: Answer;
  available: Source[];
  selected: Source[];
}
export interface Execution {
  outcome: Outcome;
  steps: Step[];
  turns: Turn[];
  sources: Source[];
  artifact?: Artifact;
  error?: {
    code: string;
    retryable: boolean;
  };
  durationMs: number;
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}
export interface Call extends Usage {
  id: number;
  phase: Phase;
  provider: "model" | "search";
  provenance: "fixture" | "live";
  status: "pending" | "ok" | "error" | "aborted";
  durationMs: number;
  httpStatus?: number;
}
export interface Totals {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  knownInputTokens: number;
  knownOutputTokens: number;
  unknownTokenCalls: number;
  costUsd: number | null;
  knownCostUsd: number;
  unknownCostCalls: number;
  providerDurationMs: number;
}
export interface Runtime {
  signal: AbortSignal;
  beginCall: (phase: Phase, provider: Call["provider"], provenance: Call["provenance"]) => (result: {
    status: "ok" | "error";
    usage?: Partial<Usage>;
    httpStatus?: number;
  }) => void;
}
export interface View {
  input: Input;
  sources: Source[];
  artifact?: Artifact;
  turns: Turn[];
  observations: Step[];
  remainingSteps: number;
}
export interface Port {
  invoke: (action: Action, view: View, runtime: Runtime) => Promise<Observation>;
  decide?: (view: View, runtime: Runtime) => Promise<Action>;
  dispose?: () => Promise<void>;
}
export interface JudgedUnit extends Unit {
  available: Source[];
  question?: string;
}
export interface JudgeInput {
  question: string;
  learningTask: string;
  expected: Expected;
  outcome: Outcome;
  units: JudgedUnit[];
}
export interface Assessment {
  taskComplete: boolean | null;
  reason: string;
  units: Array<{
    id: string;
    supported: boolean | null;
    relevant: boolean | null;
  }>;
}
export type Judge = (input: JudgeInput, runtime: Runtime) => Promise<unknown>;
export interface Check {
  id: string;
  pass: boolean;
  detail: string;
}
export interface Grade {
  rules: "pass" | "fail";
  semantics: "not_requested" | "unavailable" | "invalid" | "evaluated";
  verdict: Verdict;
  checks: Check[];
  units: JudgedUnit[];
  assessment?: Assessment;
  metrics: {
    workflowCompleted: boolean;
    quoteContainment: boolean | null;
    sourceBinding: boolean | null;
    citationCount: number;
    authorChecks: number;
    assessedUnits: number;
    unsupportedUnits: number;
    unsupportedRate: number | null;
    taskComplete: boolean | null;
    answerableTurns: number;
    overRefusals: number;
    insufficientTurns: number;
    correctGaps: number;
  };
}
export interface Attempt {
  number: number;
  execution: Execution;
  grade: Grade;
  calls: Call[];
  totals: Totals;
  executionMs: number;
  gradingMs: number;
  wallMs: number;
}
export interface CaseResult {
  id: string;
  /** Reproduction record only; never passed to the product or policy. */
  task: Task;
  purpose: Purpose;
  mode: Mode;
  taskHash: string;
  attempts: Attempt[];
  firstAttemptSuccess: boolean;
  retrySuccess: boolean;
  firstAttemptRulesPass: boolean;
  retryRulesPass: boolean;
  finalVerdict: Verdict;
  totals: Totals;
  wallMs: number;
}
export interface RunReport {
  schemaVersion: 3;
  complete: boolean;
  runId: string;
  subject: {
    commit: string;
    model: string;
    profile: "fixture" | "product";
  };
  measurement: {
    scorer: string;
    datasetHash: string;
    caseSetHash: string;
    fixtureHash: string;
    judge: string;
    policy: string;
    budgets: string;
    sourceMode: "fixed" | "live";
  };
  cases: CaseResult[];
  totals: Totals;
  totalsByPhase: Record<Phase, Totals>;
  wallMs: number;
}
