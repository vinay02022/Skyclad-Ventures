import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { AppConfig } from "./config.js";
import { registerObservabilityRoutes } from "./modules/observability/routes.js";

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
}

// App builder is separated from the listener so tests can use `app.inject(...)`
// without binding a real port.
export async function buildApp({ config, logger }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Pino's Logger is structurally compatible with FastifyBaseLogger at runtime;
    // the cast bridges a small declared-type gap (msgPrefix) without dragging
    // Fastify types into the rest of the app.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
    // Trust an inbound x-request-id if present, otherwise mint one. This is the
    // correlation ID surfaced in logs, metrics labels, and (later) request_logs rows.
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
        return incoming;
      }
      return randomUUID();
    },
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "request_id",
    bodyLimit: 1024 * 1024, // 1 MB; LLM prompts can be large but a hard cap prevents abuse.
  });

  // Echo the request id back so clients can correlate.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "skyclad-gateway",
    env: config.NODE_ENV,
    uptime_s: Math.round(process.uptime()),
  }));

  await registerObservabilityRoutes(app);

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "not_found", path: req.url });
  });

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    req.log.error({ err }, "unhandled error");
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({
      error: status === 500 ? "internal_error" : err.name,
      message: status === 500 ? "Internal server error" : err.message,
      request_id: req.id,
    });
  });

  return app;
}
