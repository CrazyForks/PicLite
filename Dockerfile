FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3456

RUN groupadd --system piclite \
    && useradd --system --gid piclite --home-dir /app piclite

COPY --from=builder --chown=piclite:piclite /app/dist/standalone ./

USER piclite
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3456/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
