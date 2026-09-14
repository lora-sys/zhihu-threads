import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ThreadAgentAction, ThreadAgentResult } from "../lib/thread-study-agent";
import {
  buildThreadMarkdown,
  readCollectedThreadSummaries,
  readCollectedThreads,
  removeCollectedThread,
  removeCollectedThreadSummary,
  saveCollectedThread,
  saveCollectedThreadSummary,
} from "../lib/thread-collection";
import { askThreadAgentFn } from "../server/ask-thread-agent";
import { readThreadArtifactFn } from "../server/read-thread-artifact";
import { removeMyThreadFn, saveMyThreadFn } from "../server/user-threads";
import { StudyBadgeCard } from "../components/thread/StudyBadgeCard";

type ThreadResponse = Awaited<ReturnType<typeof readThreadArtifactFn>>;
type AskThreadAgent = Awaited<ReturnType<typeof askThreadAgentFn>>;

type AgentMessage =
  | { readonly kind: "user"; readonly content: string }
  | { readonly kind: "assistant"; readonly result: ThreadAgentResult }
  | { readonly kind: "error"; readonly content: string };

type AgentConversationTurn = { readonly role: "user" | "assistant"; readonly content: string };

type SourceSelection = {
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
  readonly boundary: string;
  readonly author: string;
};

const UNCERTAINTY_LABELS: Record<number, string> = {
  1: "低不确定性",
  2: "较低不确定性",
  3: "中等不确定性",
  4: "较高不确定性",
  5: "高不确定性",
};

const UNCERTAINTY_COLORS: Record<number, string> = {
  1: "bg-success-soft text-success",
  2: "bg-success-soft text-success",
  3: "bg-info-soft text-info",
  4: "bg-update-soft text-update",
  5: "bg-update-soft text-update",
};

const NODE_BORDER_COLORS: Record<string, string> = {
  relationship: "border-l-node-relationship",
  cause: "border-l-node-cause",
  evolution: "border-l-node-evolution",
  consensus: "border-l-node-consensus",
  divergence: "border-l-node-divergence",
  changed_premise: "border-l-node-premise",
  unknown: "border-l-node-unknown",
};

const LEARNING_NODE_LABELS: Record<string, string> = {
  relationship: "关系",
  cause: "因果",
  evolution: "演变",
  consensus: "共识",
  divergence: "分歧",
  changed_premise: "前提变化",
  unknown: "待确认",
};

const GUIDE_ROLE_LABELS: Record<string, string> = {
  baseline: "基础认知",
  correction: "边界修正",
  extension: "深化扩展",
  counterpoint: "不同视角",
  current_usage: "当前用法",
  unclear: "待确认",
};

const GUIDE_ROLE_COLORS: Record<string, string> = {
  baseline: "bg-info-soft text-info",
  correction: "bg-update-soft text-update",
  extension: "bg-success-soft text-success",
  counterpoint: "bg-accent-soft text-accent",
  current_usage: "bg-paper-2 text-ink",
  unclear: "bg-paper-2 text-muted",
};

const QUICK_PROMPTS = [
  "请按时间线解释这条学习线的核心脉络。",
  "请指出这些回答中的关键分歧，并说明依据。",
  "请给出最适合的下一步追问。",
  "请说明当前摘录能回答什么、不能回答什么。",
] as const;

export const Route = createFileRoute("/thread/$threadId")({
  head: ({ params }) => ({
    title: `学习线程 #${params.threadId.slice(0, 8)} · Zhihu Threads`,
    meta: [{ title: "学习线程", name: "description", content: "问题学习线程" }],
    links: [
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon.png" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
    ],
  }),
  component: ThreadView,
});

function EvidenceChip({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-8 max-w-full items-center border border-accent bg-accent-soft px-2 py-1 font-mono text-[10px] font-medium text-accent transition-colors duration-150 hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="h-4 w-4 fill-none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

function ThreadView() {
  const { threadId } = Route.useParams();
  const navigate = useNavigate();
  const boundRead = useServerFn(readThreadArtifactFn);
  const boundAsk = useServerFn(askThreadAgentFn);
  const boundSaveMyThread = useServerFn(saveMyThreadFn);
  const boundRemoveMyThread = useServerFn(removeMyThreadFn);

  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<ThreadResponse | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceSelection | null>(null);
  const [agentMessages, setAgentMessages] = useState<readonly AgentMessage[]>([]);
  const [agentQuestion, setAgentQuestion] = useState("");
  const [agentLoading, setAgentLoading] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [copiedQuery, setCopiedQuery] = useState<string | null>(null);
  const [collected, setCollected] = useState(false);
  const [collectionFeedback, setCollectionFeedback] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const agentLogRef = useRef<HTMLDivElement>(null);
  const agentInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResponse(null);
    setAgentMessages([]);
    setAgentQuestion("");

    boundRead({ data: { threadId } })
      .then((result) => {
        if (!cancelled) {
          setResponse(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResponse({
            success: false,
            code: "ARTIFACT_CORRUPTED",
            message: "加载学习线程时出现异常。",
          });
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [boundRead, threadId]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedSource !== null) {
        setSelectedSource(null);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [selectedSource]);

  useEffect(() => {
    if (agentLogRef.current) {
      agentLogRef.current.scrollTop = agentLogRef.current.scrollHeight;
    }
  }, [agentMessages, agentLoading]);

  const shareLink = useCallback(() => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (!navigator.clipboard || !url) return;
    void navigator.clipboard.writeText(url).then(() => setCopiedShare(true));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !response?.success) return;
    const ids = readCollectedThreads(window.localStorage);
    const isCollected = ids.includes(response.artifact.threadId);
    setCollected(isCollected);
    if (
      isCollected &&
      !readCollectedThreadSummaries(window.localStorage).some(
        (item) => item.threadId === response.artifact.threadId,
      )
    ) {
      saveCollectedThreadSummary(response.artifact, window.localStorage);
    }
  }, [response]);

  const collectThread = useCallback(() => {
    if (!response?.success) return;
    if (collected) {
      const ids = removeCollectedThread(response.artifact.threadId, window.localStorage);
      removeCollectedThreadSummary(response.artifact.threadId, window.localStorage);
      setCollected(ids.includes(response.artifact.threadId));
      setCollectionFeedback("已从本机收藏移除");

      void boundRemoveMyThread({ data: { threadId: response.artifact.threadId } })
        .then((result) => {
          if (result.changed) setCollectionFeedback("已从你的学习空间移除");
        })
        .catch(() => undefined);
      return;
    }

    const ids = saveCollectedThread(response.artifact.threadId, window.localStorage);
    const localSummaries = saveCollectedThreadSummary(response.artifact, window.localStorage);
    setCollected(ids.includes(response.artifact.threadId));
    setCollectionFeedback("已收藏到本机浏览器");

    const summary = localSummaries.find((item) => item.threadId === response.artifact.threadId);
    if (!summary) return;

    void boundSaveMyThread({ data: { summary } })
      .then((result) => {
        if (result.changed) setCollectionFeedback("已保存到你的知乎学习空间");
      })
      .catch(() => undefined);
  }, [boundRemoveMyThread, boundSaveMyThread, collected, response]);

  const exportThread = useCallback(
    (format: "markdown" | "json") => {
      if (!response?.success) return;
      const artifact = response.artifact;
      const content =
        format === "markdown" ? buildThreadMarkdown(artifact) : JSON.stringify(artifact, null, 2);
      const filename = `living-answer-${artifact.threadId}.${format === "markdown" ? "md" : "json"}`;
      const blob = new Blob([content], {
        type: format === "markdown" ? "text/markdown;charset=utf-8" : "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setCollectionFeedback(format === "markdown" ? "Markdown 已导出" : "JSON 已导出");
    },
    [response],
  );

  const copyText = useCallback((value: string) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => setCopiedQuery(value));
  }, []);

  const openSourceByFingerprint = useCallback(
    (fingerprint: string) => {
      if (!response?.success) return;
      const stage = response.artifact.timelineStages.find(
        (item) => item.excerpt.fingerprint === fingerprint,
      );
      if (!stage) return;
      setSelectedSource({
        url: stage.canonicalUrl,
        title: stage.title,
        excerpt: stage.excerpt.excerpt,
        boundary: stage.excerptBoundaryNote,
        author: stage.authorDisplayName,
      });
    },
    [response],
  );

  const askAgent = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || agentLoading || !response?.success) return;

      setAgentQuestion("");
      setAgentLoading(true);
      setAgentMessages((current) => [...current, { kind: "user", content: trimmed }]);

      const conversation = agentMessages.flatMap<AgentConversationTurn>((message) => {
        if (message.kind === "user") {
          return [{ role: "user" as const, content: message.content }];
        }
        if (message.kind === "assistant") {
          return [{ role: "assistant" as const, content: message.result.answer }];
        }
        return [];
      });

      const raw = (await boundAsk({
        data: {
          threadId,
          question: trimmed,
          conversation,
        },
      }).catch(() => null)) as AskThreadAgent | null;

      if (raw?.success) {
        setAgentMessages((current) => [...current, { kind: "assistant", result: raw.response }]);
      } else {
        setAgentMessages((current) => [
          ...current,
          {
            kind: "error",
            content: raw?.message ?? "AI 学习助手暂时不可用，请稍后再试。",
          },
        ]);
      }
      setAgentLoading(false);
    },
    [agentLoading, agentMessages, boundAsk, response, threadId],
  );

  const handleAgentAction = useCallback(
    (action: ThreadAgentAction) => {
      if (action.type === "focus_source" && action.answerId) {
        if (!response?.success) return;
        const stage = response.artifact.timelineStages.find(
          (item) => item.answerId === action.answerId,
        );
        if (stage) {
          openSourceByFingerprint(stage.excerpt.fingerprint);
        }
        return;
      }
      if (action.type === "copy_search" && action.query) {
        copyText(action.query);
        return;
      }
      if (action.type === "search_supplement" && action.query) {
        const isUiPrompt = QUICK_PROMPTS.some((prompt) => prompt === action.query);
        const supplementQuery = isUiPrompt
          ? response?.success
            ? response.artifact.refinedQuery
            : action.query
          : action.query;
        void navigate({
          to: "/",
          search: { q: supplementQuery, clarify: true },
        });
        return;
      }
      if (action.type === "next_question" && action.query) {
        void askAgent(action.query);
      }
    },
    [askAgent, copyText, navigate, openSourceByFingerprint, response],
  );

  if (loading) {
    return (
      <main className="min-h-screen bg-paper pb-20 text-ink">
        <div className="mx-auto w-full max-w-[1120px] px-5 pt-10 sm:px-8">
          <div className="space-y-4">
            <div className="h-7 w-2/3 animate-pulse bg-paper-3" />
            <div className="h-28 w-full animate-pulse border border-rule bg-paper-3 shadow-[var(--shadow-card)]" />
            <div className="h-28 w-full animate-pulse border border-rule bg-paper-3 shadow-[var(--shadow-card)]" />
            <div className="h-28 w-full animate-pulse border border-rule bg-paper-3 shadow-[var(--shadow-card)]" />
          </div>
        </div>
      </main>
    );
  }

  if (!response || response.success === false) {
    const isNotFound = response?.code === "ARTIFACT_NOT_FOUND";
    return (
      <main className="min-h-screen bg-paper pb-20 text-ink">
        <div className="mx-auto w-full max-w-xl px-5 pt-20 sm:px-8">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            THREAD VIEWER
          </p>
          <h1 className="mt-5 font-display text-[32px] font-normal leading-[38px] tracking-[-0.01em] text-ink sm:text-[44px] sm:leading-[48px]">
            {isNotFound ? "该线程不存在" : "线程数据损坏"}
          </h1>
          <p className="mt-4 max-w-[68ch] leading-7 text-ink-subtle">
            {isNotFound
              ? "这个学习线程不存在或已被移除。请返回首页重新生成。"
              : "该学习线程数据损坏，无法显示。请返回首页重新生成。"}
          </p>
          <button
            type="button"
            onClick={() => void navigate({ to: "/" })}
            className="mt-8 inline-flex h-12 items-center justify-center border-2 border-accent bg-accent px-8 text-sm font-semibold text-white transition-all duration-120 hover:bg-accent-hover hover:shadow-[3px_3px_0_var(--color-accent)] active:bg-accent-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            返回首页
          </button>
        </div>
      </main>
    );
  }

  const artifact = response.artifact;
  const guide = artifact.learningGuide;
  const guideStageMap = new Map(guide.stages.map((stage) => [stage.answerId, stage]));
  const sortedStages = [...artifact.timelineStages].sort((a, b) => a.editTime - b.editTime);
  const uniqueYears =
    new Set(sortedStages.map((stage) => Math.floor(stage.editTime * 1000))).size > 1;
  const sortedNodes = [...artifact.learningNodes].sort((a, b) => {
    const order = [
      "relationship",
      "cause",
      "evolution",
      "consensus",
      "divergence",
      "changed_premise",
      "unknown",
    ];
    const aIdx = order.indexOf(a.kind);
    const bIdx = order.indexOf(b.kind);
    return aIdx - bIdx;
  });

  const uncertaintyLevel =
    artifact.uncertainty < 0.2
      ? 1
      : artifact.uncertainty < 0.4
        ? 2
        : artifact.uncertainty < 0.6
          ? 3
          : artifact.uncertainty < 0.8
            ? 4
            : 5;
  const uncertaintyColorClass = UNCERTAINTY_COLORS[uncertaintyLevel];
  const uncertaintyLabel = UNCERTAINTY_LABELS[uncertaintyLevel];

  const sourceNodeKinds = new Map<string, string[]>();
  for (const node of sortedNodes) {
    const kinds = sourceNodeKinds.get(node.sourceAnswerId) ?? [];
    kinds.push(LEARNING_NODE_LABELS[node.kind] ?? node.kind);
    sourceNodeKinds.set(node.sourceAnswerId, kinds);
  }

  const truncateEvidence = (value: string) =>
    value.length > 52 ? `${value.slice(0, 52)}…` : value;

  return (
    <main className="min-h-screen bg-paper pb-24 text-ink sm:pb-20">
      <header className="border-b-2 border-rule-strong bg-paper-3">
        <div className="mx-auto w-full max-w-[1280px] px-5 py-6 sm:px-8 sm:py-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                QUESTION THREAD
              </p>
              <h1 className="mt-2 font-display text-[28px] font-bold leading-[1.15] tracking-tight text-ink sm:text-[36px]">
                {artifact.question}
              </h1>
              <p className="mt-3 max-w-[68ch] text-sm leading-6 text-ink-subtle">
                学习意图：{artifact.refinedQuery}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <span
                className={`inline-flex min-h-11 items-center border px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] ${uncertaintyColorClass}`}
              >
                {uncertaintyLabel}
              </span>
              <button
                type="button"
                onClick={shareLink}
                className="inline-flex min-h-11 items-center justify-center border-2 border-rule-strong bg-paper-3 px-4 text-xs font-medium text-ink transition-colors duration-150 hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {copiedShare ? "链接已复制" : "复制分享链接"}
              </button>
              <button
                type="button"
                onClick={collectThread}
                className="inline-flex min-h-11 items-center justify-center border-2 border-rule-strong bg-paper-3 px-4 text-xs font-medium text-ink transition-colors duration-150 hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {collected ? "已收藏" : "收藏线程"}
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1280px] gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_368px] lg:gap-10 lg:py-12">
        <div className="min-w-0 space-y-12 lg:space-y-16">
          <StudyBadgeCard
            artifact={artifact}
            onExportMarkdown={() => exportThread("markdown")}
            onExportJson={() => exportThread("json")}
          />

          <section aria-labelledby="learning-bridge-heading">
            <div className="max-w-3xl">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">
                LEARNING BRIDGE
              </p>
              <h2
                id="learning-bridge-heading"
                className="mt-3 font-display text-[28px] font-bold leading-[1.15] tracking-tight text-ink sm:text-[34px]"
              >
                记忆廊桥
              </h2>
              <p className="mt-3 max-w-[68ch] text-base leading-7 text-ink-subtle">
                {uniqueYears
                  ? "AI 把跨年份回答串成一条可追问的学习路径。每段解释都能回到真实摘录。"
                  : "当前来源集中在相近时间。AI 先组织成观点对照线；缺少历史对照时会明确标注。"}
              </p>
            </div>

            <article className="mt-8 border-2 border-rule-strong bg-paper-3 p-5 shadow-[var(--shadow-panel)] sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                    AI OVERVIEW
                  </p>
                  <h3 className="mt-2 text-[20px] font-semibold leading-8 text-ink">
                    {guide.overview.headline}
                  </h3>
                </div>
              </div>
              <p className="mt-3 max-w-[72ch] text-base leading-7 text-ink-subtle">
                {guide.overview.summary}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {guide.overview.evidenceRefs.map((ref) => (
                  <EvidenceChip
                    key={`${ref.excerptFingerprint}-${ref.quote}`}
                    label={`摘录 ${truncateEvidence(ref.quote)}`}
                    onClick={() => openSourceByFingerprint(ref.excerptFingerprint)}
                  />
                ))}
              </div>
            </article>

            <ol className="relative mt-10 list-none space-y-8 pl-10 sm:pl-12">
              <div
                aria-hidden="true"
                className="absolute bottom-4 left-[15px] top-4 w-[2px] bg-rule"
              />
              {sortedStages.map((stage, index) => {
                const guideStage = guideStageMap.get(stage.answerId);
                const roleClass =
                  GUIDE_ROLE_COLORS[guideStage?.role ?? "unclear"] ?? GUIDE_ROLE_COLORS.unclear;
                const evidenceRef = guideStage?.evidenceRefs[0];
                const nodeKinds = sourceNodeKinds.get(stage.answerId);

                return (
                  <li key={stage.answerId} className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute -left-10 top-4 flex h-8 w-8 items-center justify-center border-2 border-rule-strong bg-paper-3 font-mono text-[11px] font-bold text-ink sm:-left-12"
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>

                    {index > 0 && (
                      <div className="mb-4 border-l-2 border-accent bg-paper-2 px-3 py-2">
                        <p className="font-mono text-[10px] uppercase tracking-[0.10em] text-accent">
                          BRIDGE STEP
                        </p>
                        <p className="mt-1 max-w-[72ch] text-sm leading-6 text-ink-subtle">
                          {guideStage?.transition ??
                            "对照上一段证据：这段支持、修正，还是扩展了前面的理解？"}
                        </p>
                      </div>
                    )}

                    <article className="border-2 border-rule-strong bg-paper-3 p-5 shadow-[var(--shadow-card)] transition-all duration-150 hover:border-accent hover:shadow-[4px_4px_0_var(--color-accent)] sm:p-6">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                              {new Date(stage.editTime * 1000).getFullYear()} 年{" "}
                              {new Date(stage.editTime * 1000).getMonth() + 1} 月
                            </span>
                            <span
                              className={`inline-flex min-h-7 items-center border px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${roleClass}`}
                            >
                              {GUIDE_ROLE_LABELS[guideStage?.role ?? "unclear"]}
                            </span>
                          </div>
                          <h3 className="mt-2 text-[17px] font-semibold leading-7 text-ink">
                            {stage.title}
                          </h3>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] tracking-[0.06em] text-muted">
                          #{stage.answerId.slice(-6)}
                        </span>
                      </div>

                      <p className="mt-3 max-w-[72ch] text-sm leading-6 text-ink-subtle">
                        {guideStage?.explanation ?? stage.excerptBoundaryNote}
                      </p>
                      <p className="mt-2 max-w-[72ch] border-l border-rule pl-3 text-sm leading-6 text-muted">
                        带走这一步：
                        {nodeKinds?.length
                          ? `记住“${nodeKinds.join("、")}”怎么改变你的判断。`
                          : "先判断这段证据回答了问题的哪一部分。"}
                      </p>

                      {evidenceRef && (
                        <div className="mt-4">
                          <EvidenceChip
                            label={`摘录 ${truncateEvidence(evidenceRef.quote)}`}
                            onClick={() => openSourceByFingerprint(evidenceRef.excerptFingerprint)}
                          />
                        </div>
                      )}

                      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule pt-4">
                        <span className="text-xs text-muted">
                          作者{" "}
                          <span className="font-medium text-ink-subtle">
                            {stage.authorDisplayName}
                          </span>
                        </span>
                        {nodeKinds && (
                          <span className="font-mono text-[10px] text-muted">
                            引用于 {nodeKinds.join("、")}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => openSourceByFingerprint(stage.excerpt.fingerprint)}
                          className="inline-flex min-h-9 items-center text-xs font-semibold text-accent transition-colors duration-150 hover:text-accent-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          查看摘录
                        </button>
                        <a
                          href={stage.canonicalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-9 items-center text-xs font-medium text-muted transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          知乎原文
                        </a>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ol>
          </section>

          <section aria-labelledby="learning-nodes-heading">
            <div className="max-w-3xl">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">
                LEARNING NODES
              </p>
              <h2
                id="learning-nodes-heading"
                className="mt-3 font-display text-[26px] font-bold leading-8 tracking-tight text-ink"
              >
                学习节点
              </h2>
              <p className="mt-3 max-w-[68ch] text-base leading-7 text-ink-subtle">
                {sortedStages.length} 条来源被整合为 {sortedNodes.length} 个学习节点。
              </p>
            </div>

            <div className="mt-8 space-y-5">
              {sortedNodes.map((node) => (
                <div
                  key={`${node.kind}-${node.sourceAnswerId}`}
                  className={
                    "border-2 border-rule-strong bg-paper-3 px-5 py-5 shadow-[var(--shadow-card)] " +
                    `border-l-[3px] ${NODE_BORDER_COLORS[node.kind] ?? "border-l-node-unknown"}`
                  }
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="inline-flex items-center border border-info bg-info-soft px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.06em] text-info">
                      {LEARNING_NODE_LABELS[node.kind] ?? node.kind}
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                      置信度 {(node.uncertainty * 100).toFixed(0)}%
                    </span>
                  </div>
                  <h3 className="mt-3 text-[17px] font-semibold leading-7 text-ink">
                    {node.title}
                  </h3>
                  <p className="mt-2 max-w-[72ch] text-sm leading-6 text-ink-subtle">
                    {node.summary}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {node.evidenceRefs.map((ref) => (
                      <EvidenceChip
                        key={`${node.kind}-${node.sourceAnswerId}-${ref.excerptFingerprint}-${ref.quote}`}
                        label={truncateEvidence(ref.quote)}
                        onClick={() => openSourceByFingerprint(ref.excerptFingerprint)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="thread-meta-heading">
            <div className="border border-rule bg-paper-2 p-5">
              <h2 id="thread-meta-heading" className="text-sm font-semibold text-ink">
                学习成果
              </h2>
              <dl className="mt-3 grid grid-cols-1 gap-3 font-mono text-[11px] text-muted sm:grid-cols-3">
                <div>
                  <dt>创建时间</dt>
                  <dd className="mt-1 text-ink-subtle">
                    {new Date(artifact.createdAt).toLocaleString("zh-CN")}
                  </dd>
                </div>
                <div>
                  <dt>线程 ID</dt>
                  <dd className="mt-1 break-all text-ink-subtle">{artifact.threadId}</dd>
                </div>
                <div>
                  <dt>指纹</dt>
                  <dd className="mt-1 break-all text-ink-subtle">{artifact.fingerprint}</dd>
                </div>
              </dl>
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => exportThread("markdown")}
                  className="inline-flex h-11 items-center justify-center border-2 border-accent bg-accent px-5 text-sm font-semibold text-white transition-all duration-120 hover:bg-accent-hover hover:shadow-[3px_3px_0_var(--color-accent)] active:bg-accent-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  导出 Markdown
                </button>
                <button
                  type="button"
                  onClick={() => exportThread("json")}
                  className="inline-flex h-11 items-center justify-center border-2 border-rule-strong bg-paper-3 px-5 text-sm font-medium text-ink transition-colors duration-150 hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  导出 JSON
                </button>
                <Link
                  to="/"
                  className="inline-flex h-11 items-center justify-center border-2 border-rule-strong bg-paper-3 px-5 text-sm font-medium text-ink transition-colors duration-150 hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  创建新线程
                </Link>
              </div>
              {collectionFeedback && (
                <p aria-live="polite" className="mt-3 text-xs text-success">
                  {collectionFeedback}
                  {collected ? (
                    <>
                      {" "}
                      <Link
                        to="/"
                        hash="my-learning"
                        className="font-medium text-accent underline underline-offset-2"
                      >
                        去学习空间看看 →
                      </Link>
                    </>
                  ) : null}
                </p>
              )}
            </div>
          </section>
        </div>

        <aside aria-labelledby="study-agent-heading" className="min-w-0">
          <div className="lg:sticky lg:top-6">
            <div className="flex h-fit flex-col border-2 border-rule-strong bg-paper-3 shadow-[var(--shadow-panel)]">
              <div className="border-b-2 border-rule-strong bg-paper-2 p-5">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">
                  STUDY AGENT
                </p>
                <h2
                  id="study-agent-heading"
                  className="mt-2 text-[18px] font-semibold leading-7 text-ink"
                >
                  学习追问
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted">
                  只基于当前线程摘录回答；不足时会明确说证据不够。
                </p>
              </div>

              <div className="flex flex-wrap gap-2 border-b border-rule p-5">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void askAgent(prompt)}
                    disabled={agentLoading}
                    className="inline-flex min-h-9 items-center border border-rule-strong bg-paper px-3 text-xs font-medium text-ink-subtle transition-colors duration-150 hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {prompt}
                  </button>
                ))}
              </div>

              <div
                ref={agentLogRef}
                role="log"
                aria-live="polite"
                aria-label="学习追问记录"
                className="max-h-[min(52vh,460px)] min-h-40 space-y-4 overflow-y-auto p-5"
              >
                {agentMessages.length === 0 && !agentLoading && (
                  <p className="text-sm leading-6 text-muted">
                    从左侧选一个追问，或直接输入你的问题。
                  </p>
                )}

                {agentMessages.map((message, index) => {
                  if (message.kind === "user") {
                    return (
                      <div key={index} className="flex justify-end">
                        <p className="max-w-[85%] border-2 border-rule-strong bg-paper px-3 py-2 text-sm leading-6 text-ink">
                          {message.content}
                        </p>
                      </div>
                    );
                  }

                  if (message.kind === "error") {
                    return (
                      <div
                        key={index}
                        role="alert"
                        className="border border-update bg-update-soft px-3 py-2 text-sm leading-6 text-update"
                      >
                        {message.content}
                      </div>
                    );
                  }

                  return (
                    <div key={index} className="space-y-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex min-h-7 items-center border px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${
                            message.result.status === "grounded"
                              ? "bg-success-soft text-success"
                              : "bg-update-soft text-update"
                          }`}
                        >
                          {message.result.status === "grounded" ? "有依据" : "证据不足"}
                        </span>
                        <span className="font-mono text-[10px] text-muted">
                          置信 {((1 - message.result.uncertainty) * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="text-sm leading-6 text-ink">{message.result.answer}</p>

                      {message.result.evidenceRefs.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {message.result.evidenceRefs.map((ref, refIndex) => (
                            <EvidenceChip
                              key={`${refIndex}-${ref.excerptFingerprint}-${ref.quote}`}
                              label={truncateEvidence(ref.quote)}
                              onClick={() => openSourceByFingerprint(ref.excerptFingerprint)}
                            />
                          ))}
                        </div>
                      )}

                      {message.result.nextActions.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {message.result.nextActions.map((action, actionIndex) => (
                            <button
                              key={`${actionIndex}-${action.type}-${action.label}-${action.query ?? action.answerId ?? ""}`}
                              type="button"
                              onClick={() => handleAgentAction(action)}
                              className="inline-flex min-h-9 items-center border border-rule-strong bg-paper-2 px-3 text-xs font-medium text-ink transition-colors duration-150 hover:border-accent hover:bg-paper-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {action.type === "copy_search" && copiedQuery === action.query
                                ? "已复制"
                                : action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {agentLoading && (
                  <div className="flex items-center gap-3 border border-rule bg-paper-2 px-3 py-3">
                    <span aria-hidden="true" className="h-2 w-2 animate-pulse bg-accent" />
                    <p className="text-sm text-ink-subtle">正在核对线程摘录…</p>
                  </div>
                )}
              </div>

              <form
                className="border-t border-rule p-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void askAgent(agentQuestion);
                }}
              >
                <label htmlFor="study-agent-question" className="text-xs font-semibold text-ink">
                  你的追问
                </label>
                <textarea
                  id="study-agent-question"
                  ref={agentInputRef}
                  value={agentQuestion}
                  onChange={(event) => setAgentQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void askAgent(agentQuestion);
                    }
                  }}
                  rows={3}
                  disabled={agentLoading}
                  placeholder="问这条学习线里的一个概念或分歧"
                  className="mt-2 min-h-24 w-full resize-y border-2 border-rule-strong bg-white px-3 py-2 text-sm leading-6 text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={agentLoading || agentQuestion.trim() === ""}
                  className="mt-3 inline-flex h-11 w-full items-center justify-center border-2 border-accent bg-accent text-sm font-semibold text-white transition-all duration-120 hover:bg-accent-hover hover:shadow-[3px_3px_0_var(--color-accent)] active:bg-accent-active focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {agentLoading ? "思考中…" : "问学习桥"}
                </button>
                <p className="mt-2 text-[11px] leading-4 text-muted">
                  macOS 用 ⌘ + Enter，Windows 用 Ctrl + Enter 发送。
                </p>
              </form>
            </div>
          </div>
        </aside>
      </div>

      {selectedSource && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/60 px-0 py-0 sm:items-start sm:px-5 sm:py-16"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelectedSource(null);
          }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            className="w-full max-w-full max-h-[85vh] overflow-y-auto border-2 border-rule-strong border-t-[3px] border-t-accent bg-paper shadow-[var(--shadow-panel)] sm:max-w-2xl sm:border-t-0"
          >
            <div className="flex items-start justify-between px-6 pt-5">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                  SOURCE EXCERPT
                </p>
                <h3 className="mt-1 text-[17px] font-semibold leading-7 text-ink">
                  {selectedSource.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSource(null)}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center border-2 border-rule text-muted transition-colors duration-150 hover:bg-paper-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                aria-label="关闭"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="mt-6 px-6">
              <p className="whitespace-pre-wrap break-words text-base leading-7 text-ink sm:text-lg sm:leading-8">
                {selectedSource.excerpt}
              </p>
            </div>

            <div className="mt-6 space-y-3 px-6">
              <div className="flex flex-wrap items-center gap-3 font-mono text-xs tracking-[0.04em] text-muted">
                <span>
                  作者: <span className="font-medium text-ink-subtle">{selectedSource.author}</span>
                </span>
              </div>
              <p className="text-sm font-semibold text-update">{selectedSource.boundary}</p>
              <a
                href={selectedSource.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center justify-center border-2 border-rule-strong bg-paper-3 px-4 text-xs font-semibold text-accent transition-colors duration-150 hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                在知乎查看原文
              </a>
            </div>

            <div className="mt-6 border-t border-rule px-6 pb-5 pt-4">
              <button
                type="button"
                onClick={() => setSelectedSource(null)}
                className="inline-flex min-h-11 items-center justify-center border-2 border-rule-strong bg-paper-3 px-4 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
