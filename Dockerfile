# syntax=docker/dockerfile:1
#
# Server image for Cloud Run (architecture.md §10.5 / §13 — the API half of the
# edge split). The server runs via `tsx src/main.ts` (no compiled artifact), so the
# image ships source + node_modules and launches through the workspace `start` script.
#
# Cloud Run injects PORT=8080; AppConfig (config.ts) reads PORT with a 3000 default,
# so no port is pinned here — the container obeys whatever Cloud Run sets.
#
# Migrations are NOT run by this image. main.ts only serves; `pnpm migrate` runs as a
# separate step in CI against the Neon DIRECT url (POSTGRES_ADMIN_URL, session mode).

FROM node:22-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Manifests + lockfile first so the install layer caches on dependency changes only,
# not on every source edit. A full workspace install is intentional: tsx (the runtime)
# is a ROOT devDependency, and esbuild (tsx's engine) is in onlyBuiltDependencies — a
# filtered install can miss the root, leaving `tsx` unresolved.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/server/package.json packages/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Source last — this layer changes most often.
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "--filter", "@catalog/server", "start"]
