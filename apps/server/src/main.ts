import { createApp } from "./app.ts";

const { app, config, lifecycle } = createApp();
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

const shutdown = async () => {
	lifecycle.logger.info("shutdown requested");
	await lifecycle.stop();
	await app.stop(true);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
