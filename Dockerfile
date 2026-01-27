# Multi-stage Dockerfile for ping-mem
# Stage 1: Build
FROM oven/bun:1.2.5-alpine AS builder

WORKDIR /build

# Copy package files
COPY package.json bun.lock ./

# Install dependencies (include devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN bun run build

# Stage 2: Runtime
FROM oven/bun:1.2.5-alpine AS runtime

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    curl \
    && rm -rf /var/cache/apk/*

# Copy built artifacts from builder
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./
COPY --from=builder /build/node_modules ./node_modules

# Create data directory
RUN mkdir -p /data

# Set environment defaults
ENV PING_MEM_HOST=0.0.0.0
ENV PING_MEM_PORT=3000
ENV PING_MEM_TRANSPORT=sse
ENV NODE_ENV=production

# Expose default port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun --version || exit 1

# Run the server
CMD ["bun", "run", "dist/http/server.js"]
