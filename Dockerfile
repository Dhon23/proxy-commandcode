FROM oven/bun:1 AS builder
WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY tsconfig.json ./

RUN case "${TARGETOS}-${TARGETARCH}" in \
      "linux-amd64") BUN_TARGET="bun-linux-x64" ;; \
      "linux-arm64") BUN_TARGET="bun-linux-arm64" ;; \
      "windows-amd64") BUN_TARGET="bun-windows-x64" ;; \
      "darwin-arm64") BUN_TARGET="bun-darwin-arm64" ;; \
      *) BUN_TARGET="bun-linux-x64" ;; \
    esac && \
    bun build --compile --minify --sourcemap ./src/server.ts \
    --target "$BUN_TARGET" \
    --outfile proxy

FROM alpine:latest
RUN apk add --no-cache gcompat ca-certificates libstdc++ && \
    addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /build/proxy /usr/local/bin/proxy

USER app
EXPOSE 3456
ENV NODE_ENV=production
CMD ["proxy"]
