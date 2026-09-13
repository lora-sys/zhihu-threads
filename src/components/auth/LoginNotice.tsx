/**
 * Result banner for the Zhihu login round trip.
 *
 * The message is deliberately limited to a closed set of reasons so provider
 * details never reach the page.
 */

export type LoginNoticeStatus = "ok" | "error";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_configured: "知乎登录尚未配置完成，暂时无法登录。",
  state: "登录链接已失效或已被使用，请重新发起登录。",
  token: "知乎授权没有完成，请重新登录。",
  profile: "暂时读不到你的知乎账号信息，请重试。",
  storage: "登录状态没能保存，请稍后重试。",
};

const messageFor = (status: LoginNoticeStatus, reason: string | undefined): string => {
  if (status === "ok") return "已使用知乎账号登录。";
  return ERROR_MESSAGES[reason ?? ""] ?? "登录没有完成，请重试。";
};

export function LoginNotice({
  status,
  reason,
  onDismiss,
}: {
  readonly status: LoginNoticeStatus;
  readonly reason: string | undefined;
  readonly onDismiss: () => void;
}) {
  const isSuccess = status === "ok";

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "mb-8 flex flex-wrap items-center justify-between gap-3 border-2 px-4 py-3 " +
        (isSuccess ? "border-success bg-success-soft" : "border-update bg-update-soft")
      }
    >
      <p className={"text-sm " + (isSuccess ? "text-success" : "text-update")}>
        {messageFor(status, reason)}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className={
          "inline-flex min-h-11 items-center border-2 bg-paper-3 px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] focus-visible:outline-2 focus-visible:outline-offset-2 " +
          (isSuccess
            ? "border-success text-success focus-visible:outline-success"
            : "border-update text-update focus-visible:outline-update")
        }
      >
        知道了
      </button>
    </div>
  );
}
