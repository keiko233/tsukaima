import { createApp } from "./app.ts";

const { app, auth, config, lifecycle } = createApp();
await app.listen({ hostname: config.host, port: config.port });
lifecycle.logger.info("server listening", {
	host: config.host,
	port: config.port,
});

try {
	await lifecycle.start();
} catch (error) {
	lifecycle.fail(error instanceof Error ? error.message : String(error));
}

let shuttingDown = false;

const shutdown = async () => {
	if (shuttingDown) {
		process.exit(1);
	}
	shuttingDown = true;
	lifecycle.logger.info("shutdown requested");
	try {
		auth.stop();
		await lifecycle.stop();
		await app.stop(true);
	} finally {
		process.exit(0);
	}
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
