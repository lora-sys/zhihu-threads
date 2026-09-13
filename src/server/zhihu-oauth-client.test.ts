import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { requestZhihuAccessToken, requestZhihuUser } from "./zhihu-oauth-client";

// ── Helpers ─────────────────────────────────────────────────────────────────

const flip = <A, E>(effect: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(effect));

interface CapturedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string | null;
}

const captureFetch = (
  response: Response | (() => Promise<Response>),
): { readonly fetchImpl: typeof fetch; readonly requests: CapturedRequest[] } => {
  const requests: CapturedRequest[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? null : await request.clone().text();
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body,
    });

    return typeof response === "function" ? response() : response;
  }) as typeof fetch;

  return { fetchImpl, requests };
};

// ── Token exchange ──────────────────────────────────────────────────────────

describe("requestZhihuAccessToken", () => {
  it("posts the documented form fields and returns the token", async () => {
    const { fetchImpl, requests } = captureFetch(
      new Response('{"access_token":"token-1","token_type":"Bearer","expires_in":3600}', {
        status: 200,
      }),
    );

    const token = await Effect.runPromise(
      requestZhihuAccessToken({
        appId: "app-1",
        appKey: "key-1",
        redirectUri: "https://example.com/api/auth/zhihu/callback",
        code: "code-1",
        fetchImpl,
      }),
    );

    expect(token.accessToken).toBe("token-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://openapi.zhihu.com/access_token");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");

    const form = new URLSearchParams(requests[0]?.body ?? "");
    expect(Object.fromEntries(form)).toEqual({
      app_id: "app-1",
      app_key: "key-1",
      grant_type: "authorization_code",
      redirect_uri: "https://example.com/api/auth/zhihu/callback",
      code: "code-1",
    });
  });

  it("reports a rejected exchange without exposing the provider body", async () => {
    const { fetchImpl } = captureFetch(
      new Response('{"error":"invalid_grant","error_description":"do not leak me"}', {
        status: 400,
      }),
    );

    const error = await flip(
      requestZhihuAccessToken({
        appId: "app-1",
        appKey: "secret-key",
        redirectUri: "https://example.com/callback",
        code: "bad-code",
        fetchImpl,
      }),
    );

    expect(error._tag).toBe("ZhihuOAuthError");
    expect(error.reason).toBe("TOKEN_EXCHANGE_REJECTED");
    expect(JSON.stringify(error)).not.toContain("secret-key");
    expect(JSON.stringify(error)).not.toContain("do not leak me");
  });

  it("reports an unusable success body as a failed exchange", async () => {
    const { fetchImpl } = captureFetch(new Response('{"code":404}', { status: 200 }));

    const error = await flip(
      requestZhihuAccessToken({
        appId: "app-1",
        appKey: "key-1",
        redirectUri: "https://example.com/callback",
        code: "code-1",
        fetchImpl,
      }),
    );

    expect(error.reason).toBe("TOKEN_EXCHANGE_FAILED");
  });

  it("maps a transport failure to a safe failure reason", async () => {
    const { fetchImpl } = captureFetch(async () => {
      throw new Error("socket hang up: key-1");
    });

    const error = await flip(
      requestZhihuAccessToken({
        appId: "app-1",
        appKey: "key-1",
        redirectUri: "https://example.com/callback",
        code: "code-1",
        fetchImpl,
      }),
    );

    expect(error.reason).toBe("TOKEN_EXCHANGE_FAILED");
    expect(JSON.stringify(error)).not.toContain("socket hang up");
  });
});

// ── Authorized user ─────────────────────────────────────────────────────────

describe("requestZhihuUser", () => {
  it("sends the bearer token and keeps the int64 uid exact", async () => {
    const uid = "969570047710216200";
    const { fetchImpl, requests } = captureFetch(
      new Response(
        `{"uid":${uid},"fullname":"张三","avatar_path":"https://picx.zhimg.com/a.jpg"}`,
        {
          status: 200,
        },
      ),
    );

    const user = await Effect.runPromise(requestZhihuUser({ accessToken: "token-1", fetchImpl }));

    expect(user).toEqual({
      uid,
      fullname: "张三",
      avatarUrl: "https://picx.zhimg.com/a.jpg",
      headline: "",
    });
    expect(requests[0]?.url).toBe("https://openapi.zhihu.com/user");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token-1");
  });

  it("rejects a non-OK response", async () => {
    const { fetchImpl } = captureFetch(new Response('{"code":20001}', { status: 401 }));

    const error = await flip(requestZhihuUser({ accessToken: "expired", fetchImpl }));
    expect(error.reason).toBe("USER_FETCH_FAILED");
  });

  it("rejects a payload that is not a usable user", async () => {
    const { fetchImpl } = captureFetch(
      new Response('{"data":"User don\'t exist"}', { status: 200 }),
    );

    const error = await flip(requestZhihuUser({ accessToken: "token-1", fetchImpl }));
    expect(error.reason).toBe("USER_FETCH_FAILED");
  });
});
