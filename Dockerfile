# Ubah production image. Build: docker build -t ubah .
# Runs TypeScript directly through tsx; the React app is built in its own stage and served as static files.
# Runs as the unprivileged "node" user.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The React app (/login, /me, /worker, /admin), built once into static files.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci && npm cache clean --force
COPY web/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY content ./content
COPY data ./data
COPY models ./models
COPY --from=web /web/dist ./web/dist
USER node
EXPOSE 3000
# Liveness only (the process answers). Load balancers should use /health, which also checks the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/live" >/dev/null || exit 1
# tini forwards SIGTERM so Ubah can shut down gracefully (finish jobs, close the database).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/server.ts"]
