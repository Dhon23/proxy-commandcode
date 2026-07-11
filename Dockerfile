FROM oven/bun:1 AS builder
WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY tsconfig.json ./

RUN bun build --compile --minify --sourcemap ./src/server.ts --outfile proxy

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system app && useradd --system --no-create-home --gid app app

COPY --from=builder --chown=app:app /build/proxy /usr/local/bin/proxy

USER app
EXPOSE 3456
ENV NODE_ENV=production
CMD ["proxy"]
