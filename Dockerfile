# Reproduzierbares Setup fuer VPS. Optional - pm2 direkt auf VM tut's auch.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --include=dev && npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Cron laeuft als node-cron innerhalb des Prozesses
CMD ["node", "dist/index.js"]
