/**
 * Zhihu OAuth network client.
 *
 * Both calls stay on the server: the app key and the returned access token must
 * never reach the browser. Failures carry a stable reason tag only, so provider
 * bodies, headers, and error causes cannot leak into responses or logs.
 *
 * @module zhihu-oauth-client
 */

import { Data, Effect } from "effect";

import {
  ZHIHU_TOKEN_ENDPOINT,
  ZHIHU_USER_ENDPOINT,
  parseZhihuTokenBody,
  parseZhihuUserBody,
  type ZhihuOAuthUser,
  type ZhihuToken,
} from "../lib/zhihu-oauth";

export type ZhihuOAuthFailureReason =
  | "TOKEN_EXCHANGE_FAILED"
  | "TOKEN_EXCHANGE_REJECTED"
  | "USER_FETCH_FAILED";

export class ZhihuOAuthError extends Data.TaggedError("ZhihuOAuthError")<{
  readonly reason: ZhihuOAuthFailureReason;
}> {}

const DEFAULT_TIMEOUT_MS = 10_000;

const runRequest = <A>(
  reason: ZhihuOAuthFailureReason,
  request: () => Promise<A>,
): Effect.Effect<A, ZhihuOAuthError> =>
  Effect.tryPromise({
    try: request,
    catch: (error) => (error instanceof ZhihuOAuthError ? error : new ZhihuOAuthError({ reason })),
  });

const safeJsonText = async (response: Response): Promise<string | null> => {
  try {
    return await response.text();
  } catch {
    return null;
  }
};

// ── Token exchange ──────────────────────────────────────────────────────────

export interface RequestAccessTokenOptions {
  readonly appId: string;
  readonly appKey: string;
  readonly redirectUri: string;
  readonly code: string;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

/**
 * Exchange the one-time authorization code for a user access token.
 *
 * The token lifetime is reported but not trusted for session decisions: the
 * session has its own max age and a rejected token simply requires a new login.
 */
export const requestZhihuAccessToken = (
  options: RequestAccessTokenOptions,
): Effect.Effect<ZhihuToken, ZhihuOAuthError> =>
  runRequest("TOKEN_EXCHANGE_FAILED", async () => {
    const fetcher = options.fetchImpl ?? fetch;
    const response = await fetcher(options.endpoint ?? ZHIHU_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        app_id: options.appId,
        app_key: options.appKey,
        grant_type: "authorization_code",
        redirect_uri: options.redirectUri,
        code: options.code,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new ZhihuOAuthError({ reason: "TOKEN_EXCHANGE_REJECTED" });
    }

    const body = await safeJsonText(response);
    const parsed = body === null ? null : parseZhihuTokenBody(body);
    if (parsed === null || !parsed.ok) {
      throw new ZhihuOAuthError({ reason: "TOKEN_EXCHANGE_FAILED" });
    }

    return parsed.token;
  });

// ── Authorized user ─────────────────────────────────────────────────────────

export interface RequestUserOptions {
  readonly accessToken: string;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

/** Read the authorized user's public profile fields used by the workspace header. */
export const requestZhihuUser = (
  options: RequestUserOptions,
): Effect.Effect<ZhihuOAuthUser, ZhihuOAuthError> =>
  runRequest("USER_FETCH_FAILED", async () => {
    const fetcher = options.fetchImpl ?? fetch;
    const response = await fetcher(options.endpoint ?? ZHIHU_USER_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new ZhihuOAuthError({ reason: "USER_FETCH_FAILED" });
    }

    const body = await safeJsonText(response);
    const parsed = body === null ? null : parseZhihuUserBody(body);
    if (parsed === null || !parsed.ok) {
      throw new ZhihuOAuthError({ reason: "USER_FETCH_FAILED" });
    }

    return parsed.user;
  });
