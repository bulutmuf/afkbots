FROM node:22.20.0-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && node -e "require('better-sqlite3')(':memory:').close()" \
  && npm cache clean --force

COPY --chown=node:node manager.js bot.js ./
COPY --chown=node:node src ./src

USER node

CMD ["node", "manager.js", "dev"]
