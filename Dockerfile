# syntax=docker/dockerfile:1
# One build, three runtime targets: app (API + UI), worker (Playwright), fake-orqea.

FROM node:22.23.4-bookworm-slim AS build
WORKDIR /src
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.23.4-bookworm-slim AS runtime-base
WORKDIR /opt/figura
ENV NODE_ENV=production
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/package.json ./
COPY personas ./personas
COPY catalogue ./catalogue
COPY config ./config
COPY app/db/migrations ./app/db/migrations

FROM runtime-base AS app
# Writable default for screenshots (an embedding compose mounts a shared volume there).
ENV FIGURA_SCREENSHOTS_DIR=/data/screenshots
RUN mkdir -p /data/screenshots && chown -R node:node /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/app/main.js"]

FROM runtime-base AS fake-orqea
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://localhost:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/fake-orqea/main.js"]

# The official Playwright image ships Chromium and its system dependencies. It runs as uid 1000
# ("ubuntu"), the same uid as "node" in the app image, so both can share the screenshots volume.
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS worker
WORKDIR /opt/figura
ENV NODE_ENV=production
ENV FIGURA_SCREENSHOTS_DIR=/data/screenshots
COPY --from=runtime-base /opt/figura ./
RUN mkdir -p /data/screenshots && chown -R 1000:1000 /data
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD pgrep -f "dist/worker/main.js" > /dev/null || exit 1
CMD ["node", "dist/worker/main.js"]
