# AionQA AI Service

`aionqa-ai-service` is the LLM gateway used by crawler/helper components.

It handles:

- token-authenticated AI requests
- provider routing (OpenAI / OpenAI-compatible / LM Studio / Ollama)
- backend logging + usage/cost reporting
- centralized secret handling (so crawler containers do not store provider keys)

## Requirements

- Node.js 20+
- npm
- Reachable backend API (`BACKEND_URL`)
- Valid auth token per request (`Authorization: Bearer ...`)

## Quick Start (OpenAI Mode)

```bash
npm ci
```

PowerShell example:

```powershell
$env:AI_MODE="openai"
$env:OPENAI_API_KEY="your-openai-key"
$env:BACKEND_URL="https://api.aionqa.com"
$env:PORT="5000"
npm start
```

Health check:

```bash
curl http://localhost:5000/health
```

## Quick Start (Docker)

```bash
docker build -t aionqa-ai-service .
docker run --rm \
  --name aionqa-ai-service \
  -p 5000:5000 \
  -e AI_MODE=openai \
  -e OPENAI_API_KEY=your-openai-key \
  -e BACKEND_URL=https://api.aionqa.com \
  aionqa-ai-service
```

## API

### `POST /api/ai/chat`

Accepts crawler/helper AI requests and returns normalized AI response payloads.

### `GET /health`

Returns service health and startup metadata.

## Configuration

### Core

- `PORT` (default: `5000`)
- `BACKEND_URL` (default: `http://back:4000`)
- `AI_MODE` (`openai`, `openai-compatible`, `lm-studio`, `ollama`; default: `openai`)
- `AI_SERVICE_TOKEN` (optional direct service token for trusted callers)

### Provider Config

#### OpenAI

- `OPENAI_API_KEY` (required for `AI_MODE=openai`)
- `OPENAI_DISABLE_WEB_SEARCH` (default strips web/browsing tools unless explicitly set to `false`)

#### OpenAI-Compatible

- `LLM_BASE_URL`
- `OPENAI_API_KEY` (or provider-compatible key)

#### LM Studio

- `LM_STUDIO_URL` (default: `http://localhost:1234`)
- `LM_STUDIO_API_KEY` (optional)
- `LM_STUDIO_MODEL` (optional)

#### Ollama

- `OLLAMA_URL` (default: `http://localhost:11434`)
- `OLLAMA_MODEL` (optional, default in service code: `llama3.2`)

### Eligibility / Overrides (Optional)

- `REQUIRE_AI_BALANCE_CHECK`
- `AI_ELIGIBILITY_CHECK_TIMEOUT_MS`
- `APP_VARS_SECRET_ARN`
- `AI_OVERRIDES_POLL_MS`
- `AWS_REGION`

## NPM Scripts

- `npm start` - start AI service
- `npm run dev` - watch mode

## Related Docs

- `SETUP.md` contains deeper architecture and deployment notes.
