/**
 * AionQA AI Service
 * 
 * Handles OpenAI API requests from crawlers.
 * Stores OpenAI API keys securely and proxies requests to OpenAI.
 */

import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 5000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || process.env.SERVICE_TOKEN;
const AI_SERVICE_TOKEN = process.env.AI_SERVICE_TOKEN || process.env.SERVICE_TOKEN;

// OpenAI client - uses API key from environment
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

/**
 * Token authentication middleware
 * Accepts AI_SERVICE_TOKEN (for helpers) or validates RUNNER_TOKEN with backend (for crawlers)
 */
async function authenticateToken(req, res, next) {
  // Skip authentication for health check
  if (req.path === '/health') {
    return next();
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  
  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  
  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }
  
  // First check: AI_SERVICE_TOKEN (for helpers/direct access)
  if (AI_SERVICE_TOKEN && token === AI_SERVICE_TOKEN) {
    return next();
  }
  
  // Second check: RUNNER_TOKEN from environment (backward compatibility)
  if (RUNNER_TOKEN && token === RUNNER_TOKEN) {
    return next();
  }
  
  // Third check: Validate token with backend (for job-specific runner tokens from crawlers)
  // Crawlers get RUNNER_TOKEN from backend jobs, so we validate with backend
  try {
    const response = await axios.get(`${BACKEND_URL}/api/runner/validate-token`, {
      headers: {
        'Authorization': `Bearer ${token}`
      },
      timeout: 5000
    });
    
    if (response.status === 200) {
      // Token is valid according to backend
      return next();
    }
  } catch (error) {
    // If backend validation fails, continue to reject
    if (error.response && error.response.status === 401) {
      console.warn(`[AI-SERVICE] Token validation failed with backend: ${error.response.status}`);
    } else {
      console.warn(`[AI-SERVICE] Backend token validation error: ${error.message}`);
    }
  }
  
  // All validation methods failed
  console.warn(`[AI-SERVICE] Invalid token attempt from ${req.ip}`);
  return res.status(401).json({ error: 'Invalid token' });
}

// Apply authentication to all routes except health
app.use(async (req, res, next) => {
  if (req.path === '/health') {
    return next();
  }
  await authenticateToken(req, res, next);
});

// OpenAI pricing (as of 2024, in USD per 1M tokens)
const pricing = {
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4o': { input: 5.00, output: 15.00 },
  'gpt-4o-mini': { input: 0.150, output: 0.600 },
  'gpt-5-mini': { input: 0.150, output: 0.600 },
  'gpt-5-nano': { input: 0.150, output: 0.600 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'o1-preview': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 3.00, output: 12.00 }
};

/**
 * Calculate cost of an OpenAI API call
 */
function calculateCost(usage, model) {
  if (!usage || !model) {
    return { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };
  }
  
  let modelPricing = pricing[model];
  if (!modelPricing) {
    // Try prefix match (e.g., gpt-4o-2024-08-06 -> gpt-4o)
    const prefix = model.split('-').slice(0, 2).join('-');
    modelPricing = pricing[prefix] || pricing['gpt-4o-mini']; // Default to gpt-4o-mini pricing
  }
  
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  
  const inputCost = (inputTokens / 1000000) * modelPricing.input;
  const outputCost = (outputTokens / 1000000) * modelPricing.output;
  const totalCost = inputCost + outputCost;
  
  return {
    inputCost,
    outputCost,
    totalCost,
    currency: 'USD',
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? (inputTokens + outputTokens)
  };
}

/**
 * Log AI request to backend
 */
async function logToBackend(jobId, level, message, metadata = {}) {
  if (!jobId || !BACKEND_URL) {
    return;
  }
  
  try {
    await axios.post(`${BACKEND_URL}/api/logs/jobs/append`, {
      jobId,
      level,
      message,
      component: 'AI-SERVICE',
      metadata
    }, {
      headers: RUNNER_TOKEN ? { 'Authorization': `Bearer ${RUNNER_TOKEN}` } : {},
      timeout: 5000
    });
  } catch (error) {
    console.error(`[AI-SERVICE] Failed to log to backend:`, error.message);
  }
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'aionqa-ai-service',
    openai_configured: !!process.env.OPENAI_API_KEY
  });
});

/**
 * Main AI request endpoint
 * Receives requests from crawlers and proxies to OpenAI
 */
app.post('/api/ai/chat', async (req, res) => {
  const startTime = Date.now();
  const {
    project_id,
    job_id,
    messages,
    input, // Responses API format (already in correct format)
    model = 'gpt-5-mini',
    temperature,
    max_tokens,
    ...otherParams
  } = req.body;

  console.log(`[AI-SERVICE] Received AI request - Job: ${job_id}, Model: ${model}`);

  try {
    // Log request start
    if (job_id) {
      await logToBackend(job_id, 'info', `🤖 AI Request: Model: ${model}`, {
        model,
        project_id,
        job_id,
        status: 'pending'
      });
    }

    // Prepare OpenAI request
    // Handle both 'input' (Responses API format) and 'messages' (Chat API format)
    let inputArray;
    if (input && Array.isArray(input)) {
      // Already in Responses API format
      inputArray = input;
      console.log(`[AI-SERVICE] Using 'input' format (${inputArray.length} items)`);
    } else if (messages && Array.isArray(messages)) {
      // Convert messages (Chat API format) to input (Responses API format)
      inputArray = messages.map(msg => {
        // If message already has 'type: message', it's already in Responses format
        if (msg.type === 'message') {
          return msg;
        }
        // Otherwise, convert from Chat format
        const content = Array.isArray(msg.content) 
          ? msg.content.map(c => {
              if (typeof c === 'string') {
                return { type: 'input_text', text: c };
              }
              if (c.type === 'text' && c.text) {
                return { type: 'input_text', text: c.text };
              }
              if (c.type === 'image_url') {
                const imageUrl = typeof c.image_url === 'string' ? c.image_url : c.image_url?.url;
                return {
                  type: 'input_image',
                  image_url: imageUrl,
                  detail: c.detail || 'auto'
                };
              }
              return c;
            })
          : [{ type: 'input_text', text: msg.content || '' }];
        
        return {
          role: msg.role || 'user',
          type: 'message',
          content: content
        };
      });
      console.log(`[AI-SERVICE] Converted 'messages' to 'input' format (${inputArray.length} items)`);
    } else {
      throw new Error('Either "input" or "messages" must be provided');
    }

    const openaiRequest = {
      model,
      input: inputArray,
      ...(temperature !== undefined && { temperature }),
      ...(max_tokens !== undefined && { max_tokens }),
      ...otherParams
    };

    // Make OpenAI API call
    const response = await openaiClient.responses.create(openaiRequest);

    // Calculate cost
    const costDetails = calculateCost(response.usage, response.model);
    const duration = Date.now() - startTime;

    // Log completion
    if (job_id) {
      const inputTokens = response.usage?.prompt_tokens ?? response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? response.usage?.output_tokens ?? 0;
      const totalTokens = response.usage?.total_tokens ?? (inputTokens + outputTokens);

      await logToBackend(job_id, 'info', 
        `✅ AI call completed in ${(duration / 1000).toFixed(2)}s - Input: ${inputTokens} tokens, Output: ${outputTokens} tokens, Total: ${totalTokens} tokens, Cost: $${costDetails.totalCost.toFixed(6)} USD`,
        {
          model: response.model,
          duration_ms: duration,
          usage: response.usage,
          cost: costDetails,
          status: 'completed',
          finish_reason: response.finish_reason || 'stop'
        }
      );
    }

    console.log(`[AI-SERVICE] ✅ AI request completed - Job: ${job_id}, Duration: ${duration}ms, Tokens: ${costDetails.totalTokens}`);

    // Return response in OpenAI format
    res.json({
      id: response.id,
      model: response.model,
      output_text: response.output_text,
      output: response.output,
      usage: response.usage,
      finish_reason: response.finish_reason || 'stop',
      status: response.status || 'completed'
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[AI-SERVICE] ❌ AI request failed - Job: ${job_id}, Error:`, error.message);

    // Log error
    if (job_id) {
      await logToBackend(job_id, 'error', 
        `❌ AI request failed: ${error.message}`,
        {
          model,
          project_id,
          error: error.message,
          error_stack: error.stack,
          duration_ms: duration,
          status: 'failed'
        }
      );
    }

    // Return error in OpenAI-like format
    res.status(error.status || 500).json({
      error: {
        message: error.message,
        type: error.type || 'api_error',
        code: error.code || 'internal_error'
      }
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 AionQA AI Service running on port ${PORT}`);
  console.log(`📡 Backend URL: ${BACKEND_URL}`);
  console.log(`🔑 OpenAI API key configured: ${!!process.env.OPENAI_API_KEY}`);
});

