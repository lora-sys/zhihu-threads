import { createFileRoute } from "@tanstack/react-router";

import { buildZhihuAuthorizeUrl } from "../../../../lib/zhihu-oauth";
import {
  createOAuthState,
  readZhihuOAuthConfig,
  setOAuthStateCookie,
} from "../../../../server/zhihu-session";

/**
 * Start the Zhihu authorization code flow.
 *
 * A fresh single-use state is bound to this browser before redirecting, and the
 * exact registered callback URI is sent to Zhihu so the callback matches.
 */
export const Route = createFileRoute("/api/auth/zhihu/start")({
  server: {
    handlers: {
      GET: async () => {
        const config = readZhihuOAuthConfig();
        if (config === null) {
          return new Response(null, {
            status: 302,
            headers: { Location: "/?login=error&reason=not_configured" },
          });
        }

        const state = createOAuthState();
        setOAuthStateCookie(state);

        return new Response(null, {
          status: 302,
          headers: {
            Location: buildZhihuAuthorizeUrl({
              appId: config.appId,
              redirectUri: config.redirectUri,
              state,
            }),
          },
        });
      },
    },
  },
});
