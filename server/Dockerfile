FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 SYNC_DATABASE_PATH=/data/sync.sqlite
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node package.json index.mjs relay.mjs ./
USER node
EXPOSE 8787
CMD ["node", "index.mjs"]
