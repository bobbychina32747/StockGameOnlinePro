FROM node:22-alpine AS web-build
WORKDIR /remaster
COPY remaster/package.json remaster/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY remaster/tsconfig.json ./
COPY remaster/apps ./apps
COPY remaster/packages ./packages
COPY remaster/tooling ./tooling
ENV REMASTER_WEB_BASE=/
RUN npm run build

FROM node:22-alpine AS core-build
WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

# Optional compatible ledger image. It uses the existing ledger volume and core
# service configuration; no migration or reset is performed by this image.
FROM node:22-alpine AS legacy-core
WORKDIR /app
COPY --from=core-build /app/package.json /app/package-lock.json ./
COPY --from=core-build /app/node_modules ./node_modules
COPY --from=core-build /app/dist ./dist
COPY --from=web-build /remaster/dist/packages ./v2-runtime/packages
ENV NODE_ENV=production V2_BACKTEST_MODULE=/app/v2-runtime/packages/engine/backtest.js
EXPOSE 8000
CMD ["node", "dist/src/main.js"]

FROM golang:1.27.2-alpine AS go-build
WORKDIR /src
COPY backend-go/go.mod backend-go/go.sum ./
RUN go mod download
COPY backend-go/cmd ./cmd
COPY backend-go/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /stockgame ./cmd/stockgame

FROM alpine:3.22 AS game-api
RUN apk add --no-cache ca-certificates && addgroup -g 1000 game && adduser -D -u 1000 -G game game
WORKDIR /app
COPY --from=go-build /stockgame ./stockgame
COPY --from=web-build /remaster/apps/web/dist ./web
COPY remaster/packages/domain/catalog.json ./catalog.json
RUN mkdir data && chown game:game data
ENV GOMEMLIMIT=64MiB GOMAXPROCS=2 REMASTER_HOST=0.0.0.0 REMASTER_PORT=8320 \
    SGP_CATALOG=/app/catalog.json SGP_WEB_ROOT=/app/web UNIFIED_COMMAND_DB=/app/data/formal-commands.sqlite
USER game
EXPOSE 8320
HEALTHCHECK --interval=30s --timeout=8s CMD wget -qO- http://127.0.0.1:8320/api/v2/health || exit 1
ENTRYPOINT ["/app/stockgame"]
