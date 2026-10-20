# syntax=docker/dockerfile:1.7
# ── build ─────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++   # argon2 native build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=384"
WORKDIR /app
RUN apk add --no-cache tini && apk upgrade --no-cache
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Non-root, no shell needed at runtime; compatible with readOnlyRootFilesystem in K8s.
USER node
EXPOSE 3000 9464
ENTRYPOINT ["/sbin/tini", "--"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1
CMD ["node", "--import", "./dist/infra/telemetry.js", "dist/server.js"]
