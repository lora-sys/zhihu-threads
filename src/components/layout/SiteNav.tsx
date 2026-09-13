import { Link } from "@tanstack/react-router";

import { ViewerControl } from "./ViewerControl";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b-2 border-rule-strong bg-paper-3">
      <nav
        aria-label="主导航"
        className="mx-auto flex h-16 w-full max-w-[1120px] items-center px-5 sm:px-8"
      >
        {/* Brand block: black square + blue overlap */}
        <Link
          to="/"
          className="relative inline-flex min-h-11 items-center font-mono text-xs font-bold tracking-[0.18em] text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          <span className="relative mr-2 h-3.5 w-3.5 border-2 border-ink" aria-hidden="true" />
          <span className="absolute -bottom-0.5 left-2 h-3 w-3 bg-accent" aria-hidden="true" />
          <span className="relative ml-3">ZHIHU THREADS</span>
        </Link>
        <div className="ml-auto flex items-center gap-3 sm:gap-5">
          <ViewerControl />
          <Link
            to="/evals"
            className="hidden min-h-11 items-center font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:inline-flex"
          >
            EVAL DASHBOARD
          </Link>
        </div>
      </nav>
    </header>
  );
}
