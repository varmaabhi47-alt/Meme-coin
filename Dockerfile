FROM node:22-alpine
ENV NODE_ENV=production RUN_MODE=persistent LIVE_TRADING=false
WORKDIR /app
COPY package.json ./
COPY --chown=node:node . .
USER node
CMD ["node","meme-radar-bot.mjs"]
