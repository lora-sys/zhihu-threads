import { createFileRoute } from "@tanstack/react-router";

const startedAt = Date.now();

/**
 * Liveness probe for the container platform.
 *
 * It reports only process liveness: no database, provider, or credential state
 * is disclosed, and the endpoint never touches an external service.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          status: "ok",
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        }),
    },
  },
});
