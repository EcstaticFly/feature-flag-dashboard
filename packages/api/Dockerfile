# Build context must be the repo root (see docker-compose.yml) so the
# workspace lockfile and the shared `core` package are available.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
# Both workspace manifests must exist before `npm ci` so the local
# @feature-flags/core dependency resolves.
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/
RUN npm ci --workspace packages/api --workspace packages/core
COPY packages/core packages/core
COPY packages/api packages/api
# core first — api imports its compiled output.
RUN npm run build -w packages/core && npm run build -w packages/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/
RUN npm ci --workspace packages/api --workspace packages/core --omit=dev && npm cache clean --force
COPY --from=build /repo/packages/core/dist packages/core/dist
COPY --from=build /repo/packages/api/dist packages/api/dist
# The migrator reads SQL files from here at runtime.
COPY packages/api/drizzle packages/api/drizzle
# Start-up script for a standalone deployment: migrate, seed, then serve.
# docker-compose does not use it — it runs those as separate one-shot services.
COPY packages/api/docker-start.sh packages/api/docker-start.sh
WORKDIR /repo/packages/api
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
