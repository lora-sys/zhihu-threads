import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { viewerFn, type ViewerResponse } from "../../server/viewer";

/**
 * Zhihu identity in the header.
 *
 * The session cookie is HttpOnly, so the client cannot read it directly; this
 * asks the server once after hydration. Until the answer arrives the control
 * keeps its width instead of guessing a state.
 */
export function ViewerControl() {
  const loadViewer = useServerFn(viewerFn);
  const [viewer, setViewer] = useState<ViewerResponse | null>(null);

  useEffect(() => {
    let active = true;

    loadViewer()
      .then((result) => {
        if (active) setViewer(result);
      })
      .catch(() => {
        if (active) setViewer({ authenticated: false, loginAvailable: false });
      });

    return () => {
      active = false;
    };
  }, [loadViewer]);

  if (viewer === null) {
    return <span aria-hidden="true" className="inline-block h-11 w-24" />;
  }

  if (!viewer.authenticated) {
    if (!viewer.loginAvailable) return null;

    return (
      <a
        href="/api/auth/zhihu/start"
        className="inline-flex min-h-11 items-center border-2 border-rule-strong bg-paper-3 px-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink transition-all duration-150 hover:shadow-[3px_3px_0_var(--color-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        使用知乎登录
      </a>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {viewer.avatarUrl === "" ? null : (
        <img
          src={viewer.avatarUrl}
          alt=""
          width={28}
          height={28}
          className="h-7 w-7 border border-rule-strong object-cover"
        />
      )}
      <span className="max-w-[9rem] truncate text-xs font-semibold text-ink">
        {viewer.displayName}
      </span>
      <form method="post" action="/api/auth/zhihu/logout" className="inline-flex">
        <button
          type="submit"
          className="inline-flex min-h-11 items-center font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          退出
        </button>
      </form>
    </div>
  );
}
