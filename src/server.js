/**
 * AionQA AI Service
 * 
 * Multi-mode LLM service supporting:
 * - OpenAI (direct API)
 * - OpenAI-compatible APIs
 * - LM Studio (local server)
 * 
 * Features:
 * - 24-hour token authentication (issued by backend)
 * - Eligibility checks (license/funds)
 * - No hardcoded secrets (all from environment)
 */

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { createLLMClient } from './llm-providers.js';
import { checkEligibility } from './eligibility-checker.js';
import { validateAIServiceToken } from './token-validator.js';

const app = express();
const PORT = process.env.PORT || 5000;
const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

// Version info for image update verification
const SERVICE_VERSION = process.env.SERVICE_VERSION || process.env.IMAGE_TAG || 'unknown';
const BUILD_DATE = process.env.BUILD_DATE || new Date().toISOString();
console.log(`[AI-SERVICE] 🏷️  Service Version: ${SERVICE_VERSION}`);
console.log(`[AI-SERVICE] 📅 Build Date: ${BUILD_DATE}`);

// LLM Mode configuration
const AI_MODE = process.env.AI_MODE || 'openai'; // openai, openai-compatible, lm-studio, ollama
const AI_SERVICE_TOKEN = process.env.AI_SERVICE_TOKEN; // Optional: for direct access (helpers)

// LLM Configuration based on mode
const llmConfig = {
  mode: AI_MODE,
  apiKey: process.env.OPENAI_API_KEY || process.env.LM_STUDIO_API_KEY || null,
  baseURL: process.env.LLM_BASE_URL,
  url: process.env.OLLAMA_URL || process.env.LM_STUDIO_URL || (AI_MODE === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234')
};

// Display name for logs
const LLM_DISPLAY_NAME = AI_MODE === 'ollama' ? 'Ollama' : (AI_MODE === 'lm-studio' ? 'LM Studio' : AI_MODE);

// Initialize LLM client
let llmClient = null;
try {
  llmClient = createLLMClient(AI_MODE, llmConfig);
  console.log(`✅ LLM client initialized in ${LLM_DISPLAY_NAME} mode`);
} catch (error) {
  console.error(`❌ Failed to initialize LLM client:`, error.message);
  if (AI_MODE === 'openai' && !llmConfig.apiKey) {
    console.error('❌ OPENAI_API_KEY is required for OpenAI mode');
    process.exit(1);
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

/**
 * Token authentication middleware
 * Supports:
 * 1. AI_SERVICE_TOKEN (for helpers/direct access)
 * 2. 24-hour tokens issued by backend (for crawlers)
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
    req.tokenInfo = { type: 'service_token', project_id: null, job_id: null };
    return next();
  }
  
  // Second check: Validate 24-hour token with backend
  const tokenInfo = await validateAIServiceToken(token);
  if (tokenInfo.valid) {
    req.tokenInfo = tokenInfo;
    return next();
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
  'o1-mini': { input: 3.00, output: 12.00 },
  'local-model': { input: 0, output: 0 } // Local models are free
};

/**
 * Calculate cost of an AI API call
 */
function calculateCost(usage, model) {
  if (!usage || !model) {
    return { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' };
  }
  
  let modelPricing = pricing[model];
  if (!modelPricing) {
    // Try prefix match (e.g., gpt-4o-2024-08-06 -> gpt-4o)
    const prefix = model.split('-').slice(0, 2).join('-');
    modelPricing = pricing[prefix] || pricing['local-model']; // Default to free for unknown models
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
    mode: AI_MODE,
    llm_configured: !!llmClient,
    backend_url: BACKEND_URL
  });
});

/**
 * Main AI request endpoint
 * Receives requests from crawlers and proxies to LLM
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

  // LM Studio / Ollama: do not send model in request; server uses its loaded/default model (per public API usage).

  // Get token info from authentication middleware
  const tokenInfo = req.tokenInfo || {};
  const requestProjectId = project_id || tokenInfo.project_id;
  const requestJobId = job_id || tokenInfo.job_id;

  // Actual model used for this mode (so logs show LM Studio/Ollama model, not request's gpt-5-mini)
  const actualModel = AI_MODE === 'ollama'
    ? (process.env.OLLAMA_MODEL || 'llama3.2')
    : AI_MODE === 'lm-studio'
      ? (process.env.LM_STUDIO_MODEL || model || 'qwen2.5-vl-3b-instruct-img2code')
      : model;

  console.log(`[AI-SERVICE] Received AI request - Job: ${requestJobId}, Model: ${actualModel}, Mode: ${AI_MODE}`);

  try {
    // Step 1: Check eligibility (license/funds)
    if (requestProjectId && requestJobId) {
      const eligibility = await checkEligibility(requestProjectId, requestJobId, model);
      if (!eligibility.eligible) {
        const errorMsg = `Request not eligible: ${eligibility.reason || 'Unknown reason'}`;
        console.warn(`[AI-SERVICE] ${errorMsg}`);
        
        await logToBackend(requestJobId, 'error', `❌ ${errorMsg}`, {
          model,
          project_id: requestProjectId,
          eligibility
        });
        
        return res.status(403).json({
          error: {
            message: errorMsg,
            type: 'eligibility_error',
            code: 'not_eligible',
            eligibility
          }
        });
      }
    }

    // Step 2: Log request start (use actualModel so logs show LM Studio/Ollama model when applicable)
    if (requestJobId) {
      await logToBackend(requestJobId, 'info', `🤖 AI Request: Model: ${actualModel}, Mode: ${AI_MODE}`, {
        model: actualModel,
        project_id: requestProjectId,
        job_id: requestJobId,
        mode: AI_MODE,
        status: 'pending'
      });
    }

    // Step 3: Prepare request based on mode
    let inputArray;
    if (input && Array.isArray(input)) {
      // Already in Responses API format
      inputArray = input;
      console.log(`[AI-SERVICE] Using 'input' format (${inputArray.length} items)`);
    } else if (messages && Array.isArray(messages)) {
      // Convert messages (Chat API format) to input (Responses API format)
      inputArray = messages.map(msg => {
        if (msg.type === 'message') {
          return msg;
        }
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

    // Step 4: Make LLM API call based on mode (with retry logic)
    let response;
    let lastError = null;
    const maxAttempts = 2;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (AI_MODE === 'ollama') {
          // Ollama: native POST /api/chat; use format: 'json' or schema when JSON requested (docs.ollama.com/capabilities/structured-outputs)
          const messages = convertInputToMessages(inputArray);
          validateChatMessages(messages);
          const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';
          const wantsJson = otherParams.text?.format?.type === 'json_object';
          const ollamaFormat = wantsJson
            ? (otherParams.response_schema && typeof otherParams.response_schema === 'object'
                ? (otherParams.response_schema.schema || otherParams.response_schema)
                : 'json')
            : undefined;
          if (attempt === 1) {
            console.log(`[AI-SERVICE] Ollama request: ${messages.length} messages, model: ${ollamaModel}, format: ${ollamaFormat === 'json' ? 'json' : ollamaFormat ? 'schema' : 'none'}`);
          }
          response = await llmClient.chat(messages, {
            model: ollamaModel,
            ...(ollamaFormat && { format: ollamaFormat })
          });
          response = convertChatToResponses(response);
        } else if (AI_MODE === 'lm-studio') {
          // LM Studio: OpenAI-compatible POST /v1/chat/completions; use response_format (json_object or json_schema per lmstudio.ai/docs/developer/openai-compat/structured-output)
          const messages = convertInputToMessages(inputArray);
          validateChatMessages(messages);
          const lmStudioModel = process.env.LM_STUDIO_MODEL || model || 'qwen2.5-vl-3b-instruct-img2code';
          const wantsJson = otherParams.text?.format?.type === 'json_object';
          let responseFormat = null;
          if (wantsJson) {
            const schema = otherParams.response_schema;
            if (schema && typeof schema === 'object' && (schema.type === 'object' || schema.schema)) {
              const rawSchema = schema.schema || schema;
              responseFormat = {
                type: 'json_schema',
                json_schema: {
                  name: schema.name || 'response',
                  strict: true,
                  schema: rawSchema
                }
              };
            } else {
              responseFormat = { type: 'json_object' };
            }
          }
          if (attempt === 1) {
            console.log(`[AI-SERVICE] LM Studio request: ${messages.length} messages, model: ${lmStudioModel}, response_format: ${responseFormat ? (responseFormat.type === 'json_schema' ? 'json_schema' : 'json_object') : 'none'}`);
          }
          response = await llmClient.chat(messages, {
            model: lmStudioModel,
            temperature: temperature !== undefined ? temperature : 0.7,
            max_tokens: max_tokens !== undefined ? max_tokens : 1000,
            ...(responseFormat && { response_format: responseFormat }),
            ...otherParams
          });
          response = convertChatToResponses(response);
        } else {
          // OpenAI and OpenAI-compatible: use response_format (text.format) with json_schema, not response_schema (400 Unknown parameter)
          const { response_schema: responseSchema, ...openaiSafeParams } = otherParams;
          const existingText = openaiSafeParams.text || {};
          let textFormat = existingText.format;
          if (responseSchema && typeof responseSchema === 'object' && (responseSchema.type === 'object' || responseSchema.schema)) {
            const rawSchema = responseSchema.schema || responseSchema;
            textFormat = {
              type: 'json_schema',
              name: responseSchema.name || 'response',
              schema: rawSchema,
              strict: true
            };
            if (attempt === 1) {
              console.log(`[AI-SERVICE] OpenAI request: using response_format (text.format) with json_schema`);
            }
          }
          const openaiRequest = {
            model,
            input: inputArray,
            ...(temperature !== undefined && { temperature }),
            ...(max_tokens !== undefined && { max_tokens }),
            ...openaiSafeParams,
            text: { ...existingText, format: textFormat }
          };
          
          if (AI_MODE === 'openai') {
            if (attempt > 1) {
              console.log(`[AI-SERVICE] OpenAI retry attempt ${attempt}/${maxAttempts}: model: ${model}`);
            }
            response = await llmClient.responses.create(openaiRequest);
          } else {
            // OpenAI-compatible: try Responses API first, fallback to Chat API
            try {
              if (attempt > 1) {
                console.log(`[AI-SERVICE] OpenAI-compatible retry attempt ${attempt}/${maxAttempts}: model: ${model}`);
              }
              response = await llmClient.responses.create(openaiRequest);
            } catch (error) {
              // Fallback to chat API (same JSON request when text.format is json_object)
              const messages = convertInputToMessages(inputArray);
              const wantsJson = otherParams.text?.format?.type === 'json_object';
              const { response_schema: _drop2, ...chatSafeParams } = otherParams;
              const chatResponse = await llmClient.chat.completions.create({
                model,
                messages,
                temperature,
                max_tokens,
                ...(wantsJson && { response_format: { type: 'json_object' } }),
                ...chatSafeParams
              });
              response = convertChatToResponses(chatResponse);
            }
          }
        }
        
        // Success - break out of retry loop
        if (attempt > 1) {
          console.log(`[AI-SERVICE] ✅ Retry succeeded on attempt ${attempt}`);
        }
        break;
        
      } catch (error) {
        lastError = error;
        
        // Log the error with detailed information
        console.error(`[AI-SERVICE] ❌ LLM API call failed (attempt ${attempt}/${maxAttempts}):`, error.message);
        if (error.response) {
          console.error(`  Status: ${error.response.status}`);
          console.error(`  Response data:`, JSON.stringify(error.response.data));
          console.error(`  Response headers:`, JSON.stringify(error.response.headers));
        }
        if (error.request) {
          console.error(`  Request config:`, {
            url: error.config?.url,
            method: error.config?.method,
            data_preview: error.config?.data ? (typeof error.config.data === 'string' ? error.config.data.substring(0, 500) : JSON.stringify(error.config.data).substring(0, 500)) : null
          });
        }
        if (error.stack) {
          console.error(`  Stack:`, error.stack);
        }
        
        // Log to backend (use actualModel so job logs show correct model)
        if (requestJobId) {
          await logToBackend(requestJobId, 'error', 
            `❌ AI request failed (attempt ${attempt}/${maxAttempts}): ${error.message}`,
            {
              model: actualModel,
              project_id: requestProjectId,
              mode: AI_MODE,
              attempt,
              max_attempts: maxAttempts,
              error: error.message,
              error_status: error.response?.status,
              error_data: error.response?.data,
              error_stack: error.stack,
              status: attempt < maxAttempts ? 'retrying' : 'failed'
            }
          );
        }
        
        // If this was the last attempt, throw the error
        if (attempt === maxAttempts) {
          throw error;
        }
        
        // Wait a bit before retry (exponential backoff: 1s, 2s)
        const retryDelay = attempt * 1000;
        console.log(`[AI-SERVICE] ⏳ Waiting ${retryDelay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    // Step 5: Calculate cost
    const costDetails = calculateCost(response.usage, response.model);
    const duration = Date.now() - startTime;

    // Step 6: Log completion
    if (requestJobId) {
      const inputTokens = response.usage?.prompt_tokens ?? response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? response.usage?.output_tokens ?? 0;
      const totalTokens = response.usage?.total_tokens ?? (inputTokens + outputTokens);

      await logToBackend(requestJobId, 'info', 
        `✅ AI call completed in ${(duration / 1000).toFixed(2)}s - Input: ${inputTokens} tokens, Output: ${outputTokens} tokens, Total: ${totalTokens} tokens, Cost: $${costDetails.totalCost.toFixed(6)} USD`,
        {
          model: response.model,
          mode: AI_MODE,
          duration_ms: duration,
          usage: response.usage,
          cost: costDetails,
          status: 'completed',
          finish_reason: response.finish_reason || 'stop'
        }
      );
    }

    console.log(`[AI-SERVICE] ✅ AI request completed - Job: ${requestJobId}, Duration: ${duration}ms, Tokens: ${costDetails.totalTokens}`);

    // Step 7: Return response in OpenAI format (normalize content to string for LM Studio array content)
    const outText = typeof response.output_text === 'string' ? response.output_text : contentToString(response.choices?.[0]?.message?.content);
    res.json({
      id: response.id,
      model: response.model,
      output_text: outText || '',
      output: response.output?.length ? response.output : [{ type: 'output_text', text: outText || '' }],
      usage: response.usage,
      finish_reason: response.finish_reason || response.choices?.[0]?.finish_reason || 'stop',
      status: response.status || 'completed'
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[AI-SERVICE] ❌ AI request failed - Job: ${requestJobId}, Error:`, error.message);

    // Log error (use actualModel so job logs show correct model)
    if (requestJobId) {
      await logToBackend(requestJobId, 'error', 
        `❌ AI request failed: ${error.message}`,
        {
          model: actualModel,
          project_id: requestProjectId,
          mode: AI_MODE,
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

/**
 * Validate and normalize chat messages (role + string content) for Ollama / LM Studio
 */
function validateChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error(`Invalid messages format: expected non-empty array, got ${typeof messages}`);
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.role || msg.content === undefined) {
      throw new Error(`Message at index ${i} missing role or content`);
    }
    if (typeof msg.content !== 'string') {
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.map(c => typeof c === 'string' ? c : (c?.text || JSON.stringify(c))).join('\n');
      } else {
        msg.content = String(msg.content ?? '');
      }
    }
  }
}

/**
 * Convert Responses API input to chat messages (for LM Studio / Ollama)
 */
function convertInputToMessages(input) {
  if (!Array.isArray(input)) {
    return [{ role: 'user', content: 'Hello' }];
  }
  
  return input.map(item => {
    if (item.type === 'message') {
      const content = item.content || [];
      const textParts = content
        .filter(c => c.type === 'input_text')
        .map(c => c.text)
        .join('\n');
      
      return {
        role: item.role || 'user',
        content: textParts || 'Hello'
      };
    }
    return { role: 'user', content: 'Hello' };
  });
}

/** Normalize message content to string (LM Studio/OpenAI can return string or array of parts) */
function contentToString(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : (p?.text ?? (p?.type === 'text' && p.text != null ? p.text : '')))).filter(Boolean).join('');
  }
  return String(content);
}

/**
 * Convert chat completion response to Responses API format
 */
function convertChatToResponses(chatResponse) {
  const choice = chatResponse.choices?.[0];
  const message = choice?.message;
  const text = contentToString(message?.content);
  return {
    id: chatResponse.id || `chatcmpl-${Date.now()}`,
    model: chatResponse.model,
    output_text: text,
    output: [
      {
        type: 'output_text',
        text
      }
    ],
    usage: chatResponse.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    },
    finish_reason: choice?.finish_reason || 'stop',
    status: 'completed'
  };
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 AionQA AI Service running on port ${PORT}`);
  console.log(`📡 Backend URL: ${BACKEND_URL}`);
  console.log(`🤖 LLM Mode: ${LLM_DISPLAY_NAME}`);
  console.log(`🔑 LLM configured: ${!!llmClient}`);
  if (AI_MODE === 'openai') {
    console.log(`   OpenAI API key: ${llmConfig.apiKey ? '✅ Configured' : '❌ Missing'}`);
  } else if (AI_MODE === 'openai-compatible') {
    console.log(`   Base URL: ${llmConfig.baseURL || 'Not configured'}`);
  } else if (AI_MODE === 'lm-studio') {
    console.log(`   ${LLM_DISPLAY_NAME} URL: ${llmConfig.url}`);
  } else if (AI_MODE === 'ollama') {
    console.log(`   Ollama URL: ${llmConfig.url}, model: ${process.env.OLLAMA_MODEL || 'llama3.2'}`);
  }
});
