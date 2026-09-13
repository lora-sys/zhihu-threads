import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { parseZhihuCallback } from "../../../../lib/zhihu-oauth";
import { requestZhihuAccessToken, requestZhihuUser } from "../../../../server/zhihu-oauth-client";
import {
  consumeOAuthState,
  readZhihuOAuthConfig,
  saveViewer,
} from "../../../../server/zhihu-session";

type LoginFailureReason = "state" | "token" | "profile" | "not_configured" | "storage";

const redirect = (location: string): Response =>
  new Response(null, { status: 302, headers: { Location: location } });

const fail = (reason: LoginFailureReason): Response => redirect(`/?login=error&reason=${reason}`);

/**
 * Handle the Zhihu authorization callback.
 *
 * The state is validated and consumed before any token exchange, so a replayed
 * or forged callback never reaches the provider. Only the display identity is
 * persisted; the access token is used once and discarded.
 */
export const Route = createFileRoute("/api/auth/zhihu/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const callback = parseZhihuCallback(url.searchParams);
        if (!callback.ok) return fail("state");

        if (!consumeOAuthState(callback.state)) return fail("state");

        const config = readZhihuOAuthConfig();
        if (config === null) return fail("not_configured");

        const token = await Effect.runPromise(
          requestZhihuAccessToken({
            appId: config.appId,
            appKey: config.appKey,
            redirectUri: config.redirectUri,
            code: callback.code,
          }),
        ).catch(() => null);
        if (token === null) return fail("token");

        const user = await Effect.runPromise(
          requestZhihuUser({ accessToken: token.accessToken }),
        ).catch(() => null);
        if (user === null) return fail("profile");

        const saved = await saveViewer(user);
        if (!saved) return fail("storage");

        return redirect("/?login=ok");
      },
    },
  },
});
