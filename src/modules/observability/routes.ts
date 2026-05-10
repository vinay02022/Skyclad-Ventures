import type { FastifyInstance } from "fastify";
import { registry } from "./metrics.js";

export async function registerObservabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
}
