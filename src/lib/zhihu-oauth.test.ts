import { describe, expect, it } from "vite-plus/test";

import {
  buildZhihuAuthorizeUrl,
  parseZhihuCallback,
  parseZhihuTokenBody,
  parseZhihuUserBody,
  quoteInt64Fields,
} from "./zhihu-oauth";

// ── Authorize URL ───────────────────────────────────────────────────────────

describe("buildZhihuAuthorizeUrl", () => {
  it("builds the documented authorization request", () => {
    const url = new URL(
      buildZhihuAuthorizeUrl({
        appId: "app_123",
        redirectUri: "https://threads.example.com/api/auth/zhihu/callback",
        state: "state-value",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://openapi.zhihu.com/authorize");
    expect(url.searchParams.get("app_id")).toBe("app_123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://threads.example.com/api/auth/zhihu/callback",
    );
  });

  it("encodes the redirect URI instead of splitting it into query parameters", () => {
    const raw = buildZhihuAuthorizeUrl({
      appId: "app",
      redirectUri: "https://example.com/callback?next=%2Fthread%2F1",
      state: "s",
    });

    expect(raw).toContain(
      "redirect_uri=https%3A%2F%2Fexample.com%2Fcallback%3Fnext%3D%252Fthread%252F1",
    );
    expect(new URL(raw).searchParams.get("next")).toBeNull();
  });
});

// ── Callback ────────────────────────────────────────────────────────────────

describe("parseZhihuCallback", () => {
  it("reads authorization_code and state", () => {
    const result = parseZhihuCallback(
      new URLSearchParams("authorization_code=code-1&state=state-1"),
    );
    expect(result).toEqual({ ok: true, code: "code-1", state: "state-1" });
  });

  it("accepts the generic code parameter as a fallback", () => {
    const result = parseZhihuCallback(new URLSearchParams("code=code-2&state=state-2"));
    expect(result).toEqual({ ok: true, code: "code-2", state: "state-2" });
  });

  it("prefers authorization_code when both are present", () => {
    const result = parseZhihuCallback(
      new URLSearchParams("authorization_code=primary&code=secondary&state=s"),
    );
    expect(result.ok && result.code).toBe("primary");
  });

  it("reports a provider error without echoing its text", () => {
    const result = parseZhihuCallback(
      new URLSearchParams("error=access_denied&error_description=secret-detail"),
    );
    expect(result).toEqual({ ok: false, reason: "PROVIDER_ERROR" });
  });

  it("requires both the code and the state", () => {
    expect(parseZhihuCallback(new URLSearchParams("state=s"))).toEqual({
      ok: false,
      reason: "MISSING_CODE",
    });
    expect(parseZhihuCallback(new URLSearchParams("authorization_code=c"))).toEqual({
      ok: false,
      reason: "MISSING_STATE",
    });
    expect(parseZhihuCallback(new URLSearchParams("authorization_code=&state="))).toEqual({
      ok: false,
      reason: "MISSING_CODE",
    });
  });
});

// ── Authorized user ─────────────────────────────────────────────────────────

describe("parseZhihuUserBody", () => {
  it("keeps an int64 uid exact", () => {
    const uid = "969570047710216200";
    const result = parseZhihuUserBody(
      `{"uid":${uid},"fullname":"张三","avatar_path":"https://picx.zhimg.com/a.jpg","headline":"一句话介绍"}`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.uid).toBe(uid);
    expect(result.user.fullname).toBe("张三");
    expect(result.user.avatarUrl).toBe("https://picx.zhimg.com/a.jpg");
    expect(result.user.headline).toBe("一句话介绍");
  });

  it("accepts a uid the provider already returned as a string", () => {
    const result = parseZhihuUserBody('{"uid":"123","fullname":"李四"}');
    expect(result.ok && result.user.uid).toBe("123");
    expect(result.ok && result.user.avatarUrl).toBe("");
  });

  it("tolerates optional fields the provider may omit", () => {
    const result = parseZhihuUserBody('{"uid":7,"fullname":"王五"}');
    expect(result.ok && result.user.headline).toBe("");
  });

  it("rejects payloads without a usable identity", () => {
    expect(parseZhihuUserBody('{"fullname":"无名"}')).toEqual({
      ok: false,
      reason: "INVALID_USER_PAYLOAD",
    });
    expect(parseZhihuUserBody('{"uid":"","fullname":"无名"}')).toEqual({
      ok: false,
      reason: "INVALID_USER_PAYLOAD",
    });
    expect(parseZhihuUserBody('{"uid":12.5,"fullname":"无名"}')).toEqual({
      ok: false,
      reason: "INVALID_USER_PAYLOAD",
    });
    expect(parseZhihuUserBody('{"uid":1}')).toEqual({
      ok: false,
      reason: "INVALID_USER_PAYLOAD",
    });
    expect(parseZhihuUserBody("[]")).toEqual({ ok: false, reason: "INVALID_USER_PAYLOAD" });
    expect(parseZhihuUserBody("not json")).toEqual({ ok: false, reason: "INVALID_USER_PAYLOAD" });
  });
});

describe("quoteInt64Fields", () => {
  it("only rewrites the requested field and leaves text alone", () => {
    const body = '{"uid":123456789012345678,"headline":"uid: 42","bio":"123"}';
    const quoted = quoteInt64Fields(body, ["uid"]);

    expect(JSON.parse(quoted)).toEqual({
      uid: "123456789012345678",
      headline: "uid: 42",
      bio: "123",
    });
  });
});

// ── Token response ──────────────────────────────────────────────────────────

describe("parseZhihuTokenBody", () => {
  it("reads the access token and lifetime", () => {
    const result = parseZhihuTokenBody(
      '{"access_token":"token-1","token_type":"Bearer","expires_in":3600}',
    );
    expect(result).toEqual({
      ok: true,
      token: { accessToken: "token-1", expiresInSeconds: 3600 },
    });
  });

  it("treats a successful code field as success when a token is present", () => {
    const result = parseZhihuTokenBody('{"code":20000,"access_token":"token-2","expires_in":60}');
    expect(result.ok && result.token.accessToken).toBe("token-2");
  });

  it("treats an unknown lifetime as zero instead of failing the login", () => {
    const result = parseZhihuTokenBody('{"access_token":"token-3"}');
    expect(result.ok && result.token.expiresInSeconds).toBe(0);
  });

  it("rejects responses without a usable token", () => {
    expect(parseZhihuTokenBody('{"code":404,"data":"User don\'t exist"}')).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_PAYLOAD",
    });
    expect(parseZhihuTokenBody('{"access_token":"   "}')).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_PAYLOAD",
    });
    expect(parseZhihuTokenBody("not json")).toEqual({
      ok: false,
      reason: "INVALID_TOKEN_PAYLOAD",
    });
  });
});
