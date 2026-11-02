# SuperMail image, for the Home Assistant add-on and for plain Docker (docker-compose.yml).
#
# The build context is always the repo root:
#   - Docker Compose: docker compose build (uses this file);
#   - Home Assistant: deploy/deploy.sh syncs the repo to the add-on folder and puts this file and
#     config.yaml at that root, as the Supervisor requires;
#   - by hand: docker buildx build -f addon/super_mail/Dockerfile .
# No build args on purpose: the Supervisor's builder overrode an ARG named SRC.

FROM node:22-bookworm-slim AS build
WORKDIR /build
# Manifests first, so source-only changes reuse the npm ci layer.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# Install scripts are skipped: better-sqlite3 ships glibc prebuilds (linux-arm64 included) and loads
# them itself, so no compiler toolchain is needed.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . ./
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && mkdir -p /out/shared /out/server /out/web \
 && cp -a package.json package-lock.json node_modules /out/ \
 && cp -a shared/package.json shared/dist /out/shared/ \
 && cp -a server/package.json server/dist /out/server/ \
 && if [ -d server/node_modules ]; then cp -a server/node_modules /out/server/; fi \
 && cp -a web/package.json web/dist /out/web/ \
 && test -f /out/web/dist/index.html \
 && test -f /out/server/dist/db/migrations/001_init.sql

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256
WORKDIR /app
COPY --from=build /out/ /app/
COPY addon/super_mail/run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
