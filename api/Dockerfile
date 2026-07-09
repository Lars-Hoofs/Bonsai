# --- deps: full install (incl. dev) for building ---
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml carries the build-script policy. --ignore-scripts: the
# only deps with build scripts are optional native optimizations (cpu-features,
# ssh2, protobufjs, msgpackr-extract, unrs-resolver, @scarf/scarf), all with JS
# fallbacks and unused by the pure-JS runtime — skipping them keeps a fresh,
# non-interactive install deterministic across pnpm versions.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# --- build: compile TypeScript -> dist ---
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# Don't let pnpm try to "repair" node_modules before running the build script
# (it would prompt to purge and abort in a non-TTY build).
ENV npm_config_verify_deps_before_run=false
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# --- prod-deps: clean production-only node_modules (no prune/purge prompt) ---
FROM node:22-alpine AS proddeps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# --- runtime ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
EXPOSE 3000
CMD ["node", "dist/main.js"]
