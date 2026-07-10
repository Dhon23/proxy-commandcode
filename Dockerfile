FROM oven/bun:1

WORKDIR /app

RUN groupadd -r app && useradd -r -g app app && \
    mkdir -p /app && chown -R app:app /app

COPY --chown=app:app package.json bun.lockb* ./
RUN bun install --production

COPY --chown=app:app src/ ./src/
COPY --chown=app:app tsconfig.json .

USER app

EXPOSE 3456

ENV NODE_ENV=production

CMD ["bun", "run", "src/server.ts"]
