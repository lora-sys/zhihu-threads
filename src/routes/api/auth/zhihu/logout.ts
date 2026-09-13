import { createFileRoute } from "@tanstack/react-router";

import { clearViewer } from "../../../../server/zhihu-session";

/**
 * Sign out. POST-only and same-site so a prefetch or cross-site navigation
 * cannot drop a visitor's session.
 */
export const Route = createFileRoute("/api/auth/zhihu/logout")({
  server: {
    handlers: {
      POST: async () => {
        await clearViewer();
        return new Response(null, { status: 303, headers: { Location: "/" } });
      },
    },
  },
});
