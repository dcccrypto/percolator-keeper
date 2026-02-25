# Builder stage
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build
RUN pnpm build

# Runner stage
FROM node:22-alpine AS runner

# Install curl for health checks
RUN apk add --no-cache curl

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Change ownership to node user
RUN chown -R node:node /app

# Switch to non-root user
USER node

EXPOSE 8081

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${KEEPER_HEALTH_PORT:-8081}/health || exit 1

CMD ["node", "dist/index.js"]
