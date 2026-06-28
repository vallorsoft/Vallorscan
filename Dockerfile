# --- Build fázis: natív modulok (better-sqlite3) fordítása ---
FROM node:20-slim AS build
WORKDIR /app

# node-gyp függőségek a better-sqlite3 fordításához
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# --- Futtató fázis: karcsú image, fordítóeszközök nélkül ---
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app

# A lefordított node_modules-t (a natív .node binárisokkal) átemeljük a build fázisból.
COPY --from=build /app /app

EXPOSE 8080
CMD ["node", "server/index.js"]
