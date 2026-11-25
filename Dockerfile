FROM node:22-alpine
ENV NODE_ENV=production RUN_MODE=persistent LIVE_TRADING=false
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node . .
USER node
CMD ["node","meme-radar-bot.mjs"]
