import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    reporters: "default",
    pool: "forks",
    testTimeout: 15_000,
    // DB-backed tests share one test database; running test files in parallel
    // would have them truncate each other mid-flight. Disable file-level
    // parallelism. Tests are still fast because they all use app.inject().
    fileParallelism: false,
  },
});
