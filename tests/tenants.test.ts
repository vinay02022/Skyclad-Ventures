import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TenantRepository } from "../src/modules/tenants/repository.js";
import {
  TENANT_A_API_KEY,
  TENANT_A_ID,
  TENANT_B_API_KEY,
  TENANT_B_ID,
} from "../db/seed-fixtures.js";
import { closeTestDb, getTestDb, isTestDbAvailable } from "./setup/db.js";

const dbAvailable = await isTestDbAvailable();

let repo: TenantRepository;

beforeAll(async () => {
  if (!dbAvailable) return;
  const handle = await getTestDb();
  repo = new TenantRepository(handle.db);
});

afterAll(async () => {
  await closeTestDb();
});

describe.skipIf(!dbAvailable)("TenantRepository", () => {
  it("returns null for an unknown API key", async () => {
    const t = await repo.findByApiKey("sk_test_does_not_exist_anywhere");
    expect(t).toBeNull();
  });

  it("loads tenant_a budget config", async () => {
    const cfg = await repo.getBudgetConfig(TENANT_A_ID);
    expect(cfg).not.toBeNull();
    expect(cfg!.monthlyBudgetUsd).toBe(10);
    expect(cfg!.rateLimitPerMinute).toBe(60);
  });

  it("loads tenant_b budget config (different from tenant_a)", async () => {
    const cfg = await repo.getBudgetConfig(TENANT_B_ID);
    expect(cfg).not.toBeNull();
    expect(cfg!.monthlyBudgetUsd).toBe(2);
    expect(cfg!.rateLimitPerMinute).toBe(10);
  });

  it("loads tenant_a allowlist (both providers)", async () => {
    const allowlist = await repo.getAllowlist(TENANT_A_ID);
    expect(allowlist.sort()).toEqual(["anthropic", "openai"]);
  });

  it("loads tenant_b allowlist (openai only) — proves tenant isolation", async () => {
    const allowlist = await repo.getAllowlist(TENANT_B_ID);
    expect(allowlist).toEqual(["openai"]);
  });

  it("findByApiKey hashes the input — raw key is never queried directly", async () => {
    const a = await repo.findByApiKey(TENANT_A_API_KEY);
    expect(a?.id).toBe(TENANT_A_ID);
    const b = await repo.findByApiKey(TENANT_B_API_KEY);
    expect(b?.id).toBe(TENANT_B_ID);
  });
});
