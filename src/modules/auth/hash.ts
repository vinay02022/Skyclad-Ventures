import { createHash, randomBytes } from "node:crypto";

// API keys are random secrets with high entropy, not user passwords. SHA-256
// is the right tool: fast lookup, deterministic, and the database column is
// uniquely indexed so auth is one indexed equality. We do NOT use bcrypt /
// argon2 here because their slowness is meant for low-entropy passwords; for
// 160-bit random keys it just makes auth slower without buying security.
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

// Issued format: sk_<env>_<24 url-safe random bytes ≈ 32 chars>.
// Production would issue keys via a one-shot endpoint and never log them;
// this helper exists for the seed script and future admin tooling.
export function generateApiKey(env: "test" | "live" = "live"): string {
  const random = randomBytes(24).toString("base64url");
  return `sk_${env}_${random}`;
}
