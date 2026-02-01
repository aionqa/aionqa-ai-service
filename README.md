# AionQA AI Service

AI service that handles OpenAI API requests from crawlers. Stores OpenAI API keys securely and proxies requests to OpenAI.

## Features

- Receives AI requests from crawlers
- Proxies requests to OpenAI API
- Logs requests and responses to backend
- Calculates costs and usage
- No OpenAI keys stored in crawlers

## Environment Variables

- `PORT` - Server port (default: 5000)
- `OPENAI_API_KEY` - OpenAI API key (required)
- `BACKEND_URL` - Backend URL for logging (default: http://back:4000)
- `RUNNER_TOKEN` or `SERVICE_TOKEN` - Token for backend authentication

## API Endpoints

### POST /api/ai/chat

Receives AI requests from crawlers and proxies to OpenAI.

**Request Body:**
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

### GET /health

Health check endpoint.

## Running

```bash
npm install
npm start
```

## Docker

```bash
docker build -t aionqa-ai-service .
docker run -p 5000:5000 -e OPENAI_API_KEY=your-key aionqa-ai-service
```



