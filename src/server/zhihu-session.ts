/**
 * Zhihu login session and OAuth state handling.
 *
 * Identity lives in a sealed, HttpOnly cookie handled by TanStack Start, so no
 * session table or shared cache is required and the app can run on a host
 * without persistent disk. The OAuth access token is used once to read the
 * profile and is then discarded: only the display identity is kept.
 *
 * @module zhihu-session
 */

import {
  clearSession,
  deleteCookie,
  getCookie,
  setCookie,
  useSession,
  type SessionConfig,
} from "@tanstack/react-start/server";

// ── Configuration ───────────────────────────────────────────────────────────

const SESSION_COOKIE_NAME = "zt_session";
const OAUTH_STATE_COOKIE_NAME = "zt_oauth_state";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_BYTES = 32;

export interface ZhihuOAuthConfig {
  readonly appId: string;
  readonly appKey: string;
  readonly redirectUri: string;
}

export interface ZhihuViewer {
  readonly uid: string;
  readonly fullname: string;
  readonly avatarUrl: string;
  readonly headline: string;
}

const isProduction = (): boolean => process.env.NODE_ENV === "production";

const getZhihuOAuthConfig = (): ZhihuOAuthConfig | null => {
  const appId = process.env.ZHIHU_OAUTH_APP_ID?.trim();
  const appKey = process.env.ZHIHU_OAUTH_APP_KEY?.trim();
  const redirectUri = process.env.ZHIHU_OAUTH_REDIRECT_URI?.trim();

  if (!appId || !appKey || !redirectUri) return null;
  return { appId, appKey, redirectUri };
};

const getSessionConfig = (): SessionConfig | null => {
  const password = process.env.SESSION_SECRET?.trim();
  if (!password || password.length < 32) return null;

  return {
    password,
    name: SESSION_COOKIE_NAME,
    maxAge: SESSION_MAX_AGE_SECONDS,
    cookie: {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "lax",
      path: "/",
    },
  };
};

/** Login is offered only when every credential it needs is present. */
export const isZhihuLoginConfigured = (): boolean =>
  getZhihuOAuthConfig() !== null && getSessionConfig() !== null;

/** Read the OAuth application credentials, or null when login is not configured. */
export const readZhihuOAuthConfig = (): ZhihuOAuthConfig | null => getZhihuOAuthConfig();

// ── OAuth state ─────────────────────────────────────────────────────────────

interface OAuthStatePayload {
  readonly expiresAt: number;
  readonly value: string;
}

const encodeState = ({ expiresAt, value }: OAuthStatePayload): string => `${expiresAt}.${value}`;

const decodeState = (raw: string): OAuthStatePayload | null => {
  const separator = raw.indexOf(".");
  if (separator <= 0) return null;

  const expiresAt = Number(raw.slice(0, separator));
  const value = raw.slice(separator + 1);
  if (!Number.isSafeInteger(expiresAt) || value === "") return null;

  return { expiresAt, value };
};

/** Create an unpredictable state value for one authorization attempt. */
export const createOAuthState = (): string => {
  const bytes = new Uint8Array(OAUTH_STATE_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Bind the state to this browser for a short window. The cookie is HttpOnly and
 * sealed by the platform's cookie signing is not required for CSRF protection:
 * an attacker cannot read or set it for another origin.
 */
export const setOAuthStateCookie = (state: string): void => {
  setCookie(
    OAUTH_STATE_COOKIE_NAME,
    encodeState({ expiresAt: Date.now() + OAUTH_STATE_TTL_MS, value: state }),
    {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
    },
  );
};

/**
 * Validate the state returned by Zhihu against the cookie, then consume it so a
 * replayed callback cannot be exchanged twice.
 */
export const consumeOAuthState = (received: string): boolean => {
  const stored = getCookie(OAUTH_STATE_COOKIE_NAME);
  deleteCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });

  if (!stored) return false;

  const payload = decodeState(stored);
  if (payload === null) return false;
  if (payload.expiresAt < Date.now()) return false;

  return payload.value === received;
};

// ── Viewer session ──────────────────────────────────────────────────────────

interface ViewerSessionData {
  viewer?: ZhihuViewer;
}

/** Currently signed-in Zhihu user, or null when there is no usable session. */
export const readViewer = async (): Promise<ZhihuViewer | null> => {
  const config = getSessionConfig();
  if (!config) return null;

  try {
    const session = await useSession<ViewerSessionData>(config);
    const viewer = session.data.viewer;
    if (!viewer || typeof viewer.uid !== "string" || viewer.uid === "") return null;
    if (typeof viewer.fullname !== "string" || viewer.fullname === "") return null;

    return {
      uid: viewer.uid,
      fullname: viewer.fullname,
      avatarUrl: typeof viewer.avatarUrl === "string" ? viewer.avatarUrl : "",
      headline: typeof viewer.headline === "string" ? viewer.headline : "",
    };
  } catch {
    return null;
  }
};

/** Persist the signed-in identity. Returns false when sessions are unavailable. */
export const saveViewer = async (viewer: ZhihuViewer): Promise<boolean> => {
  const config = getSessionConfig();
  if (!config) return false;

  try {
    const session = await useSession<ViewerSessionData>(config);
    await session.update({ viewer });
    return true;
  } catch {
    return false;
  }
};

/** Drop the session cookie entirely. */
export const clearViewer = async (): Promise<void> => {
  const config = getSessionConfig();
  if (!config) return;

  try {
    await clearSession({ name: config.name, cookie: config.cookie });
  } catch {
    // A missing or malformed cookie is already a signed-out state.
  }
};
