# syntax=docker/dockerfile:1.7

FROM oven/bun:latest AS build
WORKDIR /app
ENV CI=1

# The repository is the build context. node_modules, data, and local env files are excluded by
# .dockerignore so the image always comes from the checked-out git revision.
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile
RUN bun run check:version
RUN bun run --filter '@tsukaima/web' build
# Runtime needs source + workspace links, not Vite/Playwright/TypeScript dev dependencies.
RUN bun prune --production

FROM oven/bun:latest AS runtime
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git ripgrep tini \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
	TSUKAIMA_HOST=0.0.0.0 \
	TSUKAIMA_PORT=7420 \
	TSUKAIMA_DATA_DIR=/data \
	TSUKAIMA_WEB_DIST=/app/apps/web/dist

COPY --from=build /app /app
RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun
EXPOSE 7420
VOLUME ["/data"]

LABEL org.opencontainers.image.title="tsukaima" \
	org.opencontainers.image.description="Bot-native agent runtime and WebUI" \
	org.opencontainers.image.source="https://github.com/example-org/tsukaima"

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:7420/readyz');process.exit(r.status===204?0:1)"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "apps/server/src/main.ts"]
