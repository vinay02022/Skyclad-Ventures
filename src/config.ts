import { z } from "zod";

// One env loader, one source of truth. Validated at boot so a misconfigured
// container fails fast with a readable error instead of mysterious runtime nulls.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // 0 is allowed because it means "let the OS pick an ephemeral port",
  // which is exactly what tests do when binding via inject() isn't used.
  PORT: z.coerce.number().int().nonnegative().default(8080),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .default("postgres://gateway:gateway@localhost:5432/gateway"),
  OPENAI_API_KEY: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  // Provider mode selection. Defaults to mock so a fresh clone, every
  // test run, and any "I just want to see the gateway move" demo never
  // accidentally bills a real provider account. Setting to "false"
  // switches each provider to its real adapter IF the corresponding
  // API key is present; missing keys fall back to mock per provider
  // (with a warning) rather than failing boot, so you can run with one
  // real upstream and one mock upstream while developing.
  MOCK_PROVIDERS: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .default("true"),
  // Admin endpoints (currently just GET /admin/tenants/:id/usage) are gated
  // behind a single bearer token. Empty / unset means the admin surface is
  // not mounted at all, so a misconfigured deploy fails closed: no
  // accidentally-public usage endpoint. Production fix: rotate via secrets
  // manager and split per-operator (we don't because the assignment scope
  // is one operator).
  ADMIN_TOKEN: z.string().optional().default(""),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
