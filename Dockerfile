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

# Create data directory for auth tokens and storage.json
RUN mkdir -p /data && chown -R bun:bun /data && \
    chown -R bun:bun /app

# Data volume for persistent state across container restarts
VOLUME /data

# Environment defaults (overridden at runtime by Central API)
ENV NODE_ENV=production
ENV DATA_DIR=/data
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

# Health check: verify the bun process is alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD pgrep -f "bun" > /dev/null || exit 1

# Bun runs TypeScript directly — no build step needed
CMD ["bun", "run", "src/index.ts"]
