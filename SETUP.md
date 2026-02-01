# AionQA AI Service Setup

## Overview

The AionQA AI Service is a separate service that handles all OpenAI API requests from crawlers. This architecture ensures:

- **Security**: OpenAI API keys are not stored in crawler containers
- **Centralization**: All AI requests go through a single service
- **Logging**: All AI requests are logged to the backend
- **Cost Tracking**: Usage and costs are calculated and logged

## Architecture

```
┌─────────────┐
│   Crawler   │
│  Container  │
└──────┬──────┘
       │ HTTP POST /api/ai/chat
       │ (No OpenAI key needed)
       ▼
┌─────────────────┐
│  AI Service     │
│  (Port 5000)    │
│  - OpenAI Key   │
│  - Logging      │
│  - Cost Calc    │
└────────┬────────┘
         │ OpenAI API
         ▼
┌─────────────┐
│   OpenAI    │
│    API      │
└─────────────┘
```

## Configuration

### Environment Variables

- `PORT` - Server port (default: 5000)
- `OPENAI_API_KEY` - OpenAI API key (required)
- `BACKEND_URL` - Backend URL for logging (default: http://back:4000)
- `RUNNER_TOKEN` or `SERVICE_TOKEN` - Token for backend authentication

### Crawler Configuration

Crawlers receive `AI_SERVICE_URL` environment variable:
- Default: `http://aionqa-ai-service:5000` (docker-compose network)
- Can be overridden via helper environment: `AI_SERVICE_URL`
- Can be configured per-project via `llm_config.endpoint`

## Deployment

### Local (Docker Compose)

Already included in `docker-compose.yml`:

```yaml
aionqa-ai-service:
  build:
    context: ./aionqa-ai-service
  environment:
    - OPENAI_API_KEY=${OPENAI_API_KEY}
    - BACKEND_URL=http://back:4000
```

### AWS ECS

Deploy as a separate ECS service:
- Use the same Docker image
- Set `OPENAI_API_KEY` in ECS secrets
- Set `BACKEND_URL` to your backend URL
- Expose port 5000

### Helper Configuration

Helpers pass `AI_SERVICE_URL` to crawler containers:

```javascript
const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://aionqa-ai-service:5000';
const containerEnv = [
  `AI_SERVICE_URL=${aiServiceUrl}`,
  // ... other env vars
];
```

## API

### POST /api/ai/chat

Receives AI requests from crawlers.

**Request:**
```json
{
  "project_id": "string",
  "job_id": "string",
  "messages": [...],
  "model": "gpt-5-mini",
  "temperature": 0.7,
  "max_tokens": 2000
}
```

**Response:**
```json
{
  "id": "response-id",
  "model": "gpt-5-mini",
  "output_text": "...",
  "output": {...},
  "usage": {...},
  "finish_reason": "stop",
  "status": "completed"
}
```

## Git Repository

This service is a separate git repository that should be:
1. Created as a private repository
2. Added as a submodule to the main aionqa project

### Adding as Submodule

```bash
cd /path/to/aionqa
git submodule add <repository-url> aionqa-ai-service
git commit -m "Add AI service as submodule"
```

## Testing

1. Start the AI service: `docker compose up -d aionqa-ai-service`
2. Check health: `curl http://localhost:5000/health`
3. Run a job that uses AI
4. Check AI service logs: `docker logs aionqa-ai-service`
5. Verify requests in backend logs

## Evidence of Success

When a job successfully uses the AI service, you should see:

1. **AI Service Logs:**
   ```
   [AI-SERVICE] Received AI request - Job: {jobId}, Model: {model}
   [AI-SERVICE] ✅ AI request completed - Job: {jobId}, Duration: {ms}ms, Tokens: {tokens}
   ```

2. **Backend Logs:**
   ```
   🤖 AI Request: Model: {model}
   ✅ AI call completed in {s}s - Input: {tokens} tokens, Output: {tokens} tokens, Cost: ${cost} USD
   ```

3. **Crawler Logs:**
   ```
   [OpenAI-Client] Using AI Service: http://aionqa-ai-service:5000 for project {projectId} (job: {jobId})
   ```



