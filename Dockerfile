# Vallorscan szerver – Fly.io / bármilyen Docker-host
FROM node:22-slim AS base
WORKDIR /app

# Manifest-ek külön rétegben → kihasználjuk a Docker cache-t
COPY package.json package-lock.json ./
# Csak a futtatáshoz kellő függőségek (a Capacitor build-eszközök kimaradnak)
RUN npm ci --omit=dev && npm cache clean --force

# Alkalmazás-kód (a public/ a böngészős/PWA frontendet is kiszolgálja)
COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/vallorscan.sqlite
EXPOSE 8080

CMD ["node", "server/index.js"]
