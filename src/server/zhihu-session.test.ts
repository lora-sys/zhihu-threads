import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// ── Server-runtime mock ─────────────────────────────────────────────────────

interface SessionRecorder {
  updates: Array<Record<string, unknown>>;
  data: Record<string, unknown>;
  cookies: Map<string, string>;
  deleted: string[];
  cleared: number;
}

const recorder: SessionRecorder = {
  updates: [],
  data: {},
  cookies: new Map(),
  deleted: [],
  cleared: 0,
};

vi.mock("@tanstack/react-start/server", () => ({
  useSession: async () => ({
    data: recorder.data,
    update: async (update: Record<string, unknown>) => {
      recorder.updates.push(update);
      recorder.data = { ...recorder.data, ...update };
      return undefined;
    },
  }),
  clearSession: async () => {
    recorder.cleared += 1;
    recorder.data = {};
  },
  getCookie: (name: string) => recorder.cookies.get(name),
  setCookie: (name: string, value: string) => {
    recorder.cookies.set(name, value);
  },
  deleteCookie: (name: string) => {
    recorder.deleted.push(name);
    recorder.cookies.delete(name);
  },
}));

const {
  clearViewer,
  consumeOAuthState,
  createOAuthState,
  isZhihuLoginConfigured,
  readViewer,
  saveViewer,
  setOAuthStateCookie,
} = await import("./zhihu-session");

// ── Fixtures ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";

const setEnv = (overrides: Record<string, string | undefined> = {}): void => {
  const env = {
    SESSION_SECRET,
    ZHIHU_OAUTH_APP_ID: "app-id",
    ZHIHU_OAUTH_APP_KEY: "app-key",
    ZHIHU_OAUTH_REDIRECT_URI: "https://example.com/api/auth/zhihu/callback",
    ...overrides,
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

beforeEach(() => {
  recorder.updates = [];
  recorder.data = {};
  recorder.cookies.clear();
  recorder.deleted = [];
  recorder.cleared = 0;
  setEnv();
});

afterEach(() => {
  setEnv({
    SESSION_SECRET: undefined,
    ZHIHU_OAUTH_APP_ID: undefined,
    ZHIHU_OAUTH_APP_KEY: undefined,
    ZHIHU_OAUTH_REDIRECT_URI: undefined,
  });
});

// ── Configuration ───────────────────────────────────────────────────────────

describe("login configuration", () => {
  it("is available only when every credential is present", () => {
    expect(isZhihuLoginConfigured()).toBe(true);
    setEnv({ ZHIHU_OAUTH_APP_KEY: undefined });
    expect(isZhihuLoginConfigured()).toBe(false);
  });

  it("rejects a session secret that is too short to be safe", () => {
    setEnv({ SESSION_SECRET: "too-short" });
    expect(isZhihuLoginConfigured()).toBe(false);
  });
});

// ── OAuth state ─────────────────────────────────────────────────────────────

describe("oauth state", () => {
  it("creates a long random state", () => {
    const first = createOAuthState();
    const second = createOAuthState();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  it("accepts the state that was issued to this browser", () => {
    const state = createOAuthState();
    setOAuthStateCookie(state);

    expect(consumeOAuthState(state)).toBe(true);
    expect(recorder.deleted).toContain("zt_oauth_state");
  });

  it("consumes the state so a replayed callback cannot reuse it", () => {
    const state = createOAuthState();
    setOAuthStateCookie(state);

    expect(consumeOAuthState(state)).toBe(true);
    expect(consumeOAuthState(state)).toBe(false);
  });

  it("rejects a mismatched state", () => {
    setOAuthStateCookie(createOAuthState());
    expect(consumeOAuthState("0".repeat(64))).toBe(false);
  });

  it("rejects a missing or expired state", () => {
    expect(consumeOAuthState("0".repeat(64))).toBe(false);

    const state = createOAuthState();
    recorder.cookies.set("zt_oauth_state", `${Date.now() - 1000}.${state}`);
    expect(consumeOAuthState(state)).toBe(false);
  });
});

// ── Viewer session ──────────────────────────────────────────────────────────

describe("viewer session", () => {
  const viewer = {
    uid: "969570047710216200",
    fullname: "张三",
    avatarUrl: "https://picx.zhimg.com/a.jpg",
    headline: "一句话介绍",
  };

  it("persists the identity and reads it back", async () => {
    expect(await saveViewer(viewer)).toBe(true);
    expect(recorder.updates[0]).toEqual({ viewer });
    expect(await readViewer()).toEqual(viewer);
  });

  it("reports no viewer when the session is empty", async () => {
    expect(await readViewer()).toBeNull();
  });

  it("ignores a session payload without a usable identity", async () => {
    recorder.data = { viewer: { uid: "", fullname: "" } };
    expect(await readViewer()).toBeNull();
  });

  it("refuses to persist without a session secret", async () => {
    setEnv({ SESSION_SECRET: undefined });
    expect(await saveViewer(viewer)).toBe(false);
    expect(recorder.updates).toEqual([]);
  });

  it("clears the session on sign out", async () => {
    await saveViewer(viewer);
    await clearViewer();
    expect(recorder.cleared).toBe(1);
    expect(await readViewer()).toBeNull();
  });
});
