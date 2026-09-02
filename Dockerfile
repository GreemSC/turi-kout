# --- Construction ----------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Les manifestes d'abord : la couche d'installation ne se reconstruit que
# lorsque les dependances changent.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build --workspace=web && npm run build --workspace=server

# --- Execution -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/turi-kout.sqlite

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
# better-sqlite3 recupere son binaire precompile pour cette plateforme.
RUN npm ci --omit=dev --workspace=turi-kout-server --include-workspace-root \
    && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
