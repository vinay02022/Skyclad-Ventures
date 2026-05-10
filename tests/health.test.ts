import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://gateway:gateway@localhost:5432/gateway",
  });
  const logger = createLogger(config);
  app = await buildApp({ config, logger });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("returns ok and a request id", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("skyclad-gateway");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("echoes back a client-supplied request id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "test-req-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("test-req-123");
  });
});

describe("GET /metrics", () => {
  it("serves Prometheus exposition format", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("process_cpu_user_seconds_total");
  });
});
