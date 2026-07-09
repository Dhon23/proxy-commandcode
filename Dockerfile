FROM node:20-alpine

WORKDIR /app
RUN addgroup -S app && adduser -S app -G app && \
    chown -R app:app /app

COPY --chown=app:app package.json .
RUN npm install --omit=dev 2>/dev/null || true

COPY --chown=app:app server.js .

USER app

EXPOSE 3456

ENV NODE_ENV=production

CMD ["node", "server.js"]
