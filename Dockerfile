# ───────────────────────────────────────────────
# Stage 1: Install dependencies
# ───────────────────────────────────────────────
FROM oven/bun:1-slim AS deps

WORKDIR /app

COPY package.json ./
COPY bun.lock* ./

RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production

# ───────────────────────────────────────────────
# Stage 2: Production runtime
# ───────────────────────────────────────────────
FROM oven/bun:1-slim AS runtime

LABEL maintainer="rlbotline"
LABEL description="rlbotline LINE Selfbot Worker Container"
LABEL version="2.0.0"

WORKDIR /app

# curl is required by scripts/worker-entrypoint.sh to poll the API and rotate
# INSTANCE_TOKEN on boot — oven/bun:1-slim (Debian slim) doesn't ship it.
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy installed dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

# Copy source code + tsconfig + entrypoint
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/worker-entrypoint.sh ./scripts/worker-entrypoint.sh

# Session (auth token + E2EE storage) persists to Redis, and any control-plane
# state to the optional Central API — nothing is written to disk here.
RUN chown -R bun:bun /app

# Environment defaults (override at runtime via env / .env)
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV COMMAND_PREFIX=!
ENV LINE_DEVICE=IOSIPAD
ENV RATE_LIMIT_CALLS=5
ENV RATE_LIMIT_WINDOW_MS=10000
ENV MESSAGE_RETENTION_HOURS=24

# Run as non-root user (security best practice)
USER bun

# Standalone app container listens on port 3000
EXPOSE 3000

# Health check: hit the inbound HTTP API. `pgrep` is NOT in bun:1-slim (the old
# check failed with "pgrep: not found", so every container reported unhealthy);
# curl is installed above and /health is unauthenticated. HTTP_PORT=0 disables
# the server, so treat that case as healthy rather than failing forever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD [ "${HTTP_PORT:-3000}" = "0" ] || curl -fsS "http://127.0.0.1:${HTTP_PORT:-3000}/health" > /dev/null || exit 1

# Bun runs TypeScript directly — no build step needed
CMD ["bun", "run", "src/index.ts"]
