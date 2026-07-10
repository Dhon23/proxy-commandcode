FROM oven/bun:1 AS builder
WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY tsconfig.json ./

RUN bun build --compile --minify --sourcemap ./src/server.ts \
  --target=bun-linux-arm64-musl \
  --outfile proxy

FROM alpine:latest
RUN apk add --no-cache ca-certificates libstdc++ && \
    addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /build/proxy /usr/local/bin/proxy

USER app
EXPOSE 3456
ENV NODE_ENV=production
CMD ["proxy"]
