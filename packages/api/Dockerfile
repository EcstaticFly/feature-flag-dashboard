# Build context must be the repo root (see docker-compose.yml) so the
# workspace lockfile is available.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/api/package.json packages/api/
RUN npm ci --workspace packages/api
COPY packages/api packages/api
RUN npm run build -w packages/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
RUN npm ci --workspace packages/api --omit=dev && npm cache clean --force
COPY --from=build /repo/packages/api/dist packages/api/dist
# The migrator reads SQL files from here at runtime.
COPY packages/api/drizzle packages/api/drizzle
WORKDIR /repo/packages/api
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
