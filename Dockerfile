FROM node:22.18.0-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web

RUN mkdir -p /data/recordings /data/tmp && chown -R node:node /data

USER node

EXPOSE 3000 8080

CMD ["node", "src/server.js"]
