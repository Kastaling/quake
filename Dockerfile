# ============================================================================
#  Quake Arena // Zombie Siege — production image
#  Multi-stage build; final stage is a slim, non-root runtime.
#  Binds cleanly behind NGINX Proxy Manager Plus (see README.md):
#    - listens on 0.0.0.0:3000 inside the container
#    - trust proxy enabled -> X-Forwarded-For honored for real client IPs
#    - /socket.io WebSocket Upgrade path passed through by NPM+
# ============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

# runtime deps (express, socket.io) + three.js served to the browser from node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=4s --start-period=8s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
