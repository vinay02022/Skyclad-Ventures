import { createDbHandle } from "../db/client.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const dbHandle = createDbHandle(config.DATABASE_URL);
  const app = await buildApp({ config, logger, db: dbHandle.db });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      await dbHandle.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  } catch (err) {
    logger.error({ err }, "failed to start server");
    process.exit(1);
  }
}

void main();
