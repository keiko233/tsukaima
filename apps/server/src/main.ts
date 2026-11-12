import { createApp } from "./app.ts";

const { app, config, lifecycle } = createApp();
await app.listen({ hostname: config.host, port: config.port });
console.log(
	JSON.stringify({
		level: "info",
		message: `server listening on http://${config.host}:${config.port}`,
		stage: "listening",
		timestamp: new Date().toISOString(),
	}),
);

try {
	await lifecycle.start();
} catch (error) {
	lifecycle.fail(error instanceof Error ? error.message : String(error));
	console.error(error);
}

const shutdown = async () => {
	await lifecycle.stop();
	await app.stop(true);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
