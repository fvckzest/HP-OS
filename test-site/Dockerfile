FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json *.mjs tickets.json source-snapshot.json ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV TEST_SITE_CONTAINER=true TEST_SITE_PORT=3100
EXPOSE 3100
CMD ["node", "server.mjs"]
