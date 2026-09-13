/**
 * Read the signed-in Zhihu identity for the navigation header.
 *
 * The response is JSON-safe and carries display data only: never the access
 * token, session contents, or credentials.
 *
 * @module viewer
 */

import { createServerFn } from "@tanstack/react-start";

import { isZhihuLoginConfigured, readViewer } from "./zhihu-session";

export type ViewerResponse =
  | {
      readonly authenticated: false;
      /** False when OAuth credentials are missing, so the UI offers no dead end. */
      readonly loginAvailable: boolean;
    }
  | {
      readonly authenticated: true;
      readonly displayName: string;
      readonly avatarUrl: string;
      readonly headline: string;
    };

export const viewerFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ViewerResponse> => {
    const viewer = await readViewer();

    if (viewer === null) {
      return { authenticated: false, loginAvailable: isZhihuLoginConfigured() };
    }

    return {
      authenticated: true,
      displayName: viewer.fullname,
      avatarUrl: viewer.avatarUrl,
      headline: viewer.headline,
    };
  },
);
