# syntax=docker/dockerfile:1.29

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
# Keep workspace dev dependencies (Vite, Tailwind, TanStack Router, Paraglide) so in-container
# upgrades can install updated packages and rebuild `@tsukaima/web` without an external redeploy.

# The runtime stage copies the tree in two layers. `node_modules` changes only with the lockfile,
# so a code-only release reuses that layer and exports a few megabytes of source instead of
# re-exporting 700 MB every deploy. The copy loop stays correct when top-level entries are added.
RUN mkdir -p /runtime \
	&& for entry in /app/* /app/.[!.]*; do \
		[ "$entry" = "/app/node_modules" ] || cp -a "$entry" /runtime/; \
	done

FROM oven/bun:latest AS runtime
# Pin upstream CLIs so device-flow, token refresh, and runtime tooling stay reproducible.
ARG GH_VERSION=2.105.0
# `uv` runs Python-based stdio MCP servers and skills. JavaScript servers use the image's own
# `bunx` (installed with Bun), so no separate Node/npm toolchain is packaged.
ARG UV_VERSION=0.13.9
# Canvas ships bundled shared libraries when it uses a prebuilt binary; a source build links
# these system libraries instead, so both paths work at runtime. Keep the native build toolchain
# in runtime as well so in-container upgrades can install or rebuild native packages without
# requiring an external `FORCE_DEPS=1` host redeploy. Python needs venv/pip because a stdio MCP
# server or skill script may create its own virtualenv and install packages into it.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bubblewrap \
		build-essential \
		ca-certificates \
		curl \
		ffmpeg \
		git \
		pkg-config \
		python3 \
		python3-pip \
		python3-venv \
		ripgrep \
		tini \
		libcairo2 \
		libcairo2-dev \
		libpango-1.0-0 \
		libpango1.0-dev \
		libjpeg62-turbo \
		libjpeg-dev \
		libgif7 \
		libgif-dev \
		librsvg2-2 \
		librsvg2-dev \
	&& gh_arch="$(dpkg --print-architecture)" \
	&& curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" -o /tmp/gh.tar.gz \
	&& tar -xzf /tmp/gh.tar.gz -C /tmp \
	&& install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh \
	&& rm -rf /var/lib/apt/lists/* /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${gh_arch}"

# `uv` lands in /usr/local/bin, which the stdio MCP transport prepends to `PATH` and the image
# PATH below already contains. A pinned tarball avoids an archive package that lags upstream.
RUN runtime_arch="$(dpkg --print-architecture)" \
	&& case "$runtime_arch" in \
		amd64) uv_arch=x86_64 ;; \
		arm64) uv_arch=aarch64 ;; \
		*) echo "unsupported architecture: $runtime_arch" >&2; exit 1 ;; \
	esac \
	&& curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" -o /tmp/uv.tar.gz \
	&& tar -xzf /tmp/uv.tar.gz -C /tmp \
	&& install -m 0755 "/tmp/uv-${uv_arch}-unknown-linux-gnu/uv" "/tmp/uv-${uv_arch}-unknown-linux-gnu/uvx" /usr/local/bin/ \
	&& rm -rf /tmp/uv.tar.gz "/tmp/uv-${uv_arch}-unknown-linux-gnu"

WORKDIR /app
# `uv tool`, `pip install --user`, and Bun package caches write below the running user's home,
# so the per-user bin directory has to be on PATH for skill scripts and workspace commands too.
ENV NODE_ENV=production \
	TSUKAIMA_HOST=0.0.0.0 \
	TSUKAIMA_PORT=7420 \
	TSUKAIMA_DATA_DIR=/data \
	TSUKAIMA_WEB_DIST=/app/apps/web/dist \
	PATH=/usr/local/bin:/home/bun/.local/bin:$PATH

# Ownership is applied during the copy: a separate `chown -R /app` rewrote the whole tree into
# another layer, which doubled the image and cost ~25 s per build. `bun` stays able to write
# /app/.git so governed workspace worktrees keep working.
COPY --from=build --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /runtime /app
# /app itself keeps the WORKDIR owner, and a governed deployment reload or in-container upgrade
# has to create or replace working-tree entries, node_modules, and WebUI dist there. Also ensure
# the Bun install cache directory is writable by `bun` for in-container dependency installs.
RUN mkdir -p /data /home/bun/.bun/install/cache \
	&& chown -R bun:bun /home/bun/.bun \
	&& chown bun:bun /app /data
USER bun
EXPOSE 7420
VOLUME ["/data"]

LABEL org.opencontainers.image.title="tsukaima" \
	org.opencontainers.image.description="Bot-native agent runtime and WebUI"

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:7420/readyz');process.exit(r.status===204?0:1)"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "apps/server/src/main.ts"]
