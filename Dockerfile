# syntax=docker/dockerfile:1

# --- build: compile the server and the web UI ---------------------------------
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# --- deps: production node_modules only ---------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- runtime -------------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data
VOLUME /data
# Web UI / API. The service only sends UDP to <strip-ip>:4003 and never binds 4002,
# so bridge networking is fine and no UDP ports need publishing.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Node is PID 1 and handles SIGTERM itself: it exits streaming cleanly before stopping.
CMD ["node", "dist/server/server/main.js"]
