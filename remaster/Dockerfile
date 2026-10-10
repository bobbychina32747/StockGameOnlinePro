FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG REMASTER_WEB_BASE=/remaster/
ENV REMASTER_WEB_BASE=$REMASTER_WEB_BASE
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=test REMASTER_HOST=0.0.0.0 REMASTER_PORT=8320
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/tooling/runtime.cjs ./tooling/runtime.cjs
RUN mkdir data && chown node:node data
USER node
EXPOSE 8320
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8320/api/v2/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--require", "./tooling/runtime.cjs", "dist/apps/game-api/main.js"]
