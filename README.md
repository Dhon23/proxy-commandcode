# Proxy CommandCode

A transparent reverse proxy that translates **OpenAI-compatible** requests (`/v1/chat/completions`) into CommandCode's internal endpoint (`/alpha/generate`), then returns responses in OpenAI format your editor understands.

Use any CommandCode model (including the Go plan) with **ZCode**, **9router**, **Cursor**, **Continue**, **Aider**, and any editor that supports custom OpenAI endpoints.

Built with **TypeScript** + **Hono** + **Zod**, runs on **Bun**, compiles to a single standalone binary.

## Why

CommandCode has two API surfaces:

| Endpoint | Plan required |
|---|---|
| `/provider/v1/chat/completions` | Pro |
| `/provider/v1/messages` | Pro |
| `/alpha/generate` | **Any plan** (Go included) |

This proxy speaks the same envelope the official CLI uses, so it works on any plan.

## How it works

```
Editor → POST /v1/chat/completions (OpenAI format)
  → Proxy translates to CommandCode format
    → POST api.commandcode.ai/alpha/generate
  ← Proxy translates NDJSON stream back to OpenAI SSE/JSON
← Editor receives standard OpenAI response
```

## Quick start

Requires **Bun** (v1.2+).

```bash
git clone https://github.com/nasrulhadi/proxy-commandcode.git
cd proxy-commandcode
bun install
bun run src/server.ts
# → listening on http://localhost:3456
```

Or run in dev mode with auto-reload:

```bash
bun run dev
```

### Docker

```bash
docker compose up -d
```

Multi-stage build compiles the TypeScript source into a standalone binary via `bun build --compile`, then copies it into a minimal Alpine image — no runtime dependencies, no Node.js, no Bun.

### Get your token

1. Go to [https://commandcode.ai/settings/billing](https://commandcode.ai/settings/billing)
2. Copy your `user_...` token
3. Use it as the API key in your editor

### Env vars

| Variable | Default | Description |
|---|---|---|
| `PCMC_PORT` | `3456` | Listening port |
| `PCMC_VERSION` | `0.41.1` | CommandCode CLI version header |
| `PCMC_ENV` | `production` | Environment string in upstream config |
| `PCMC_RATE_LIMIT_RPM` | `15` | Max requests per minute per API key |
| `PCMC_RATE_LIMIT_TPM` | `600000` | Max tokens per minute per API key |

## Integration

### 9router

```json
{
  "commandcode": {
    "base_url": "http://localhost:3456/v1",
    "api_key": "user_xxxxxxxxxx",
    "models": ["deepseek/deepseek-v4-pro", "moonshotai/Kimi-K2.5"]
  }
}
```

### ZCode

Set custom OpenAI endpoint in settings:

- **Base URL**: `http://localhost:3456/v1`
- **API Key**: your `user_...` token
- **Model**: `deepseek/deepseek-v4-pro`

### Cursor

Settings → OpenAI API Key → Override Base URL: `http://localhost:3456/v1`

### Continue (VS Code)

```json
{
  "models": [{
    "title": "DeepSeek V4 Pro",
    "provider": "openai",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "user_xxxxxxxxxx",
    "model": "deepseek/deepseek-v4-pro"
  }]
}
```

### Aider

```bash
aider --openai-api-base http://localhost:3456/v1 \
      --openai-api-key user_xxxxxxxxxx \
      --model openai/deepseek/deepseek-v4-pro
```

### Other editors

Any editor with custom OpenAI endpoint support works the same way: point base URL to `http://localhost:3456/v1`, use your token as API key.

## Available models

Open-weight models accessible on any plan:

| Model |
|---|
| `deepseek/deepseek-v4-pro` |
| `deepseek/deepseek-v4-flash` |
| `moonshotai/Kimi-K2.5` |
| `moonshotai/Kimi-K2.6` |
| `moonshotai/Kimi-K2.7` |
| `Qwen/Qwen3.7-Max` |
| `Qwen/Qwen3.7-Plus` |
| `Qwen/Qwen3.6-Max-Preview` |
| `GLM/GLM-5.2` |
| `GLM/GLM-5.1` |
| `GLM/GLM-5` |
| `MiniMax/MiniMax-M3` |
| `MiniMax/MiniMax-M2.7` |
| `MiniMax/MiniMax-M2.5` |
| `MiMo/MiMo-V2.5-Pro` |
| `MiMo/MiMo-V2.5` |
| `stepfun/Step-3.7` |
| `stepfun/Step-3.5-Flash` |
| `nvidia/Nemotron-3-Ultra` |

> Model list may change. Check `GET /provider/v1/models` for current roster.

## Logs

Logs are JSON-structured via pino. In development, `pino-pretty` adds colorized output. In production (`PCMC_ENV=production`), plain JSON is written to stdout.

```
{"level":30,"msg":"[req] deepseek/deepseek-v4-pro stream=true"}
{"level":30,"msg":"[upstream] 200"}
{"level":30,"msg":"[done] text=1052 reasoning=38 tools=2 reason=tool_calls"}
```

### Common errors

| Log | Fix |
|---|---|
| `[upstream] 401` | Token invalid. Get a fresh one from billing. |
| `[upstream] 400` | Request format mismatch. Check proxy version. |
| `[upstream] timeout` | Upstream took >5 min. Retry. |

## Architecture

| Concern | Implementation |
|---|---|
| Runtime | Bun (native TypeScript) |
| Server framework | Hono |
| Validation | Zod schemas |
| Logging | pino (JSON structured) |
| Rate limiting | In-memory sliding window, per API key |
| Deployment | Multi-stage Docker → standalone binary on Alpine |

### Development

```bash
bun install          # Install deps
bun run dev          # Start with hot-reload
bun run typecheck    # TypeScript type check
```

## License

MIT
