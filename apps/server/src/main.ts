import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createApp, listenOptions } from "./app.ts";
import type { RestartIntent } from "./services/restart-coordinator.ts";

const { app, auth, config, lifecycle } = createApp();

let shuttingDown = false;

const shutdown = async (exitCode = 0, restartIntent?: RestartIntent) => {
	if (shuttingDown) {
		process.exit(1);
	}
	shuttingDown = true;
	lifecycle.logger.info("shutdown requested", {
		exitCode,
		restartMode: restartIntent?.mode,
	});
	try {
		if (restartIntent !== undefined) {
			await mkdir(config.dataDir, { recursive: true });
			await Bun.write(
				join(config.dataDir, "restart-intent.json"),
				JSON.stringify(restartIntent, null, 2),
			);
		}
		auth.stop();
		await lifecycle.stop();
		await app.stop(true);
	} finally {
		process.exit(exitCode);
	}
};

// Register before startup: recovery re-arms an overdue durable intent with a zero-delay timer,
// so a missing handler would turn resumed work into a failure.
lifecycle.setRestartHandler(async (intent) => {
	lifecycle.logger.info("maintenance window reached", {
		executeAtMs: intent.executeAtMs,
		mode: intent.mode,
		reason: intent.reason,
	});
	await shutdown(75, intent);
});

await app.listen(listenOptions(config));
lifecycle.logger.info("server listening", {
	host: config.host,
	port: config.port,
});

try {
	await lifecycle.start();
} catch (error) {
	lifecycle.fail(error instanceof Error ? error.message : String(error));
}

try {
	await auth.ensureInitialized();
} catch (error) {
	lifecycle.logger.error("admin authentication failed to initialize", {
		error: error instanceof Error ? error.message : String(error),
	});
}

process.on("SIGINT", () => {
	void shutdown();
});
process.on("SIGTERM", () => {
	void shutdown();
});
