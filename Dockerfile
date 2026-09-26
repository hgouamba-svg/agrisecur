# AgriSecur — image de production (Fly.io, ou tout hébergeur compatible Docker)
# Node 22 : nécessaire pour le module natif node:sqlite utilisé par db.js.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# La base SQLite vit sur le volume persistant monté sur /data (cf. fly.toml),
# jamais dans l'image : elle survit ainsi aux redéploiements.
ENV DB_PATH=/data/agrisecur.db
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
