# syntax=docker/dockerfile:1.7

# Dependencies live in a prepared image (ops/deploy/prepare-deps.sh) tagged with the lockfile and
# workspace-manifest hash. A deploy reuses that image, so an ordinary image build never runs
# `bun install`; only a lockfile or manifest change prepares a new one.
ARG DEPS_IMAGE=oven/bun:latest

# Target `deps`: toolchain plus installed node_modules. Built on demand, not on every deploy.
FROM oven/bun:latest AS deps
WORKDIR /app
ENV CI=1

# `canvas` (sticker-meme) downloads a prebuilt binary and falls back to node-gyp when that
# download is unavailable. Keep the compiler toolchain so a clean build never depends on a
# network fetch from GitHub releases.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential \
		python3 \
		pkg-config \
		libcairo2-dev \
		libpango1.0-dev \
		libjpeg-dev \
		libgif-dev \
		librsvg2-dev \
	&& rm -rf /var/lib/apt/lists/*

# The repository is the build context. node_modules, data, and local env files are excluded by
# .dockerignore so the prepared image always comes from the checked-out git revision.
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile

# Target `build` and `runtime`: the deployable image. Everything up to the dependency image is
# already prepared, so this only re-checks out source, builds the WebUI, and prunes dev packages.
FROM ${DEPS_IMAGE} AS build
WORKDIR /app
ENV CI=1
RUN test -d /app/node_modules || { \
		echo "missing node_modules: build the dependency image first (ops/deploy/prepare-deps.sh)" >&2; \
		exit 1; \
	}

COPY . .
RUN bun run check:version
RUN bun run --filter '@tsukaima/web' build
# Runtime needs source + workspace links, not Vite/Playwright/TypeScript dev dependencies.
RUN bun prune --production

# The runtime stage copies the tree in two layers. `node_modules` changes only with the lockfile,
# so a code-only release reuses that layer and exports a few megabytes of source instead of
# re-exporting 700 MB every deploy. The copy loop stays correct when top-level entries are added.
RUN mkdir -p /runtime \
	&& for entry in /app/* /app/.[!.]*; do \
		[ "$entry" = "/app/node_modules" ] || cp -a "$entry" /runtime/; \
	done

FROM oven/bun:latest AS runtime
# Canvas ships bundled shared libraries when it uses a prebuilt binary; a source build links
# these system libraries instead, so both paths work at runtime.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		git \
		ripgrep \
		tini \
		libcairo2 \
		libpango-1.0-0 \
		libjpeg62-turbo \
		libgif7 \
		librsvg2-2 \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
	TSUKAIMA_HOST=0.0.0.0 \
	TSUKAIMA_PORT=7420 \
	TSUKAIMA_DATA_DIR=/data \
	TSUKAIMA_WEB_DIST=/app/apps/web/dist

# Ownership is applied during the copy: a separate `chown -R /app` rewrote the whole tree into
# another layer, which doubled the image and cost ~25 s per build. `bun` stays able to write
# /app/.git so governed self-iteration worktrees keep working.
COPY --from=build --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /runtime /app
RUN mkdir -p /data && chown bun:bun /data
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
