/**
 * Pure Zhihu OAuth protocol helpers.
 *
 * The protocol shapes come from the hackathon OAuth integration notes in the
 * official zhihu-cli skill (0.7.2): the callback carries `authorization_code`,
 * the token endpoint expects that value as `code`, and the hackathon service
 * passes `state` through unchanged.
 *
 * Nothing here reads environment variables or performs network calls, so the
 * whole protocol surface is unit-testable.
 *
 * @module zhihu-oauth
 */

// ── Endpoints ───────────────────────────────────────────────────────────────

export const ZHIHU_AUTHORIZE_ENDPOINT = "https://openapi.zhihu.com/authorize";
export const ZHIHU_TOKEN_ENDPOINT = "https://openapi.zhihu.com/access_token";
export const ZHIHU_USER_ENDPOINT = "https://openapi.zhihu.com/user";

// ── Authorize URL ───────────────────────────────────────────────────────────

export interface BuildAuthorizeUrlInput {
  readonly appId: string;
  readonly redirectUri: string;
  readonly state: string;
}

export const buildZhihuAuthorizeUrl = (input: BuildAuthorizeUrlInput): string => {
  const url = new URL(ZHIHU_AUTHORIZE_ENDPOINT);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("app_id", input.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  return url.toString();
};

// ── Callback ────────────────────────────────────────────────────────────────

export type ZhihuCallbackFailureReason = "PROVIDER_ERROR" | "MISSING_CODE" | "MISSING_STATE";

export type ZhihuCallbackParseResult =
  | { readonly ok: true; readonly code: string; readonly state: string }
  | { readonly ok: false; readonly reason: ZhihuCallbackFailureReason };

/**
 * Read the authorization code and state from the callback query string.
 *
 * `authorization_code` is the parameter the hackathon service returns; `code`
 * is accepted as a compatibility fallback because the generic protocol notes
 * describe that shape.
 */
export const parseZhihuCallback = (params: URLSearchParams): ZhihuCallbackParseResult => {
  const providerError = params.get("error");
  if (providerError !== null && providerError.trim() !== "") {
    return { ok: false, reason: "PROVIDER_ERROR" };
  }

  const code = (params.get("authorization_code") ?? params.get("code") ?? "").trim();
  if (code === "") return { ok: false, reason: "MISSING_CODE" };

  const state = (params.get("state") ?? "").trim();
  if (state === "") return { ok: false, reason: "MISSING_STATE" };

  return { ok: true, code, state };
};

// ── Authorized user ─────────────────────────────────────────────────────────

export interface ZhihuOAuthUser {
  /** Zhihu numeric id kept as a string: it exceeds JavaScript's safe integer range. */
  readonly uid: string;
  readonly fullname: string;
  readonly avatarUrl: string;
  readonly headline: string;
}

export type ZhihuUserParseResult =
  | { readonly ok: true; readonly user: ZhihuOAuthUser }
  | { readonly ok: false; readonly reason: "INVALID_USER_PAYLOAD" };

const INT64_FIELDS = ["uid"] as const;

/**
 * Quote integer fields before parsing.
 *
 * `uid` is an int64 and would lose precision through a plain `JSON.parse`. The
 * documented requirement is to keep it lossless from the first parse, so the
 * digits are wrapped in quotes in the raw body rather than converted later.
 */
export const quoteInt64Fields = (body: string, fields: readonly string[] = INT64_FIELDS): string =>
  fields.reduce(
    (current, field) =>
      current.replace(
        new RegExp(`("${field}"\\s*:\\s*)(-?\\d+)(?=\\s*[,}])`, "g"),
        (_match, prefix: string, digits: string) => `${prefix}"${digits}"`,
      ),
    body,
  );

/** Parse the `/user` payload, tolerating optional fields but never a missing id. */
export const parseZhihuUserBody = (body: string): ZhihuUserParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteInt64Fields(body));
  } catch {
    return { ok: false, reason: "INVALID_USER_PAYLOAD" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "INVALID_USER_PAYLOAD" };
  }

  const record = parsed as Record<string, unknown>;
  const uid = typeof record.uid === "string" ? record.uid.trim() : "";
  if (uid === "" || !/^\d+$/.test(uid)) {
    return { ok: false, reason: "INVALID_USER_PAYLOAD" };
  }

  const fullname = typeof record.fullname === "string" ? record.fullname.trim() : "";
  if (fullname === "") {
    return { ok: false, reason: "INVALID_USER_PAYLOAD" };
  }

  return {
    ok: true,
    user: {
      uid,
      fullname,
      avatarUrl: typeof record.avatar_path === "string" ? record.avatar_path.trim() : "",
      headline: typeof record.headline === "string" ? record.headline.trim() : "",
    },
  };
};

// ── Token response ──────────────────────────────────────────────────────────

export interface ZhihuToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export type ZhihuTokenParseResult =
  | { readonly ok: true; readonly token: ZhihuToken }
  | { readonly ok: false; readonly reason: "INVALID_TOKEN_PAYLOAD" };

/**
 * Parse the token payload. The hackathon and historical endpoints disagree on
 * the business `code` field (some return `code: 20000` on success), so success
 * is decided by the presence of a usable token instead of that field.
 */
export const parseZhihuTokenBody = (body: string): ZhihuTokenParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "INVALID_TOKEN_PAYLOAD" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "INVALID_TOKEN_PAYLOAD" };
  }

  const record = parsed as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token.trim() : "";
  if (accessToken === "") {
    return { ok: false, reason: "INVALID_TOKEN_PAYLOAD" };
  }

  const expiresIn = record.expires_in;
  const expiresInSeconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.floor(expiresIn)
      : 0;

  return { ok: true, token: { accessToken, expiresInSeconds } };
};
