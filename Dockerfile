# Builder stage
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy package files. pnpm-workspace.yaml is required: it is where pnpm.overrides
# now live (moved out of package.json in 989d893), and --frozen-lockfile compares
# the resolved overrides against the ones recorded in pnpm-lock.yaml. Without this
# file pnpm sees no overrides, disagrees with the lockfile, and fails the build
# with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# SDK is now on npm (@percolatorct/sdk) — no vendor directory needed

# Install all dependencies (including devDeps for TypeScript compilation)
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

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy package files for prod-only install. pnpm-workspace.yaml carries the
# overrides the lockfile was resolved with — see the builder stage above.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# K-NEW-1: install production deps only — excludes vitest, vite, tsx, @types/*
# and their associated CVEs from the final image. (pnpm install --prod is deprecated;
# use --prod flag which maps to --only=prod in pnpm v10)
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Change ownership to node user
RUN chown -R node:node /app

# Switch to non-root user
USER node

EXPOSE 8081

# Health check — start-period must exceed worst-case startup discovery
# (4 retries × escalating delays = ~110s, plus inter-program spacing)
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -f http://localhost:${KEEPER_HEALTH_PORT:-8081}/health || exit 1

CMD ["node", "dist/index.js"]
