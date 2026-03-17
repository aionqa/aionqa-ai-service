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

/**
 * Ensure every object in a JSON schema is valid for OpenAI strict mode:
 * - additionalProperties: false
 * - required: array including every key in properties (OpenAI requires this; no extra keys)
 * - object types without "properties" get properties: {}, required: [] so they are not dropped by the API
 * Mutates the schema in place.
 */
function ensureStrictSchema(schema) {
  if (!schema || typeof schema !== 'object') return;
  // Fix object types that have no "properties" (OpenAI may drop them and then "required" has extra keys)
  if (schema.type === 'object' && !(schema.properties && typeof schema.properties === 'object')) {
    schema.properties = {};
    schema.additionalProperties = false;
    schema.required = [];
  }
  // Normalize any node that has "properties": fix children first so nested object types get explicit properties
  if (schema.properties && typeof schema.properties === 'object') {
    const propKeys = Object.keys(schema.properties);
    for (const key of propKeys) {
      const child = schema.properties[key];
      if (child && child.type === 'object' && !(child.properties && typeof child.properties === 'object')) {
        child.properties = {};
        child.additionalProperties = false;
        child.required = [];
      }
      ensureStrictSchema(child);
    }
    schema.required = [...propKeys];
    if (!('additionalProperties' in schema)) {
      schema.additionalProperties = false;
    }
  }
  if (schema.type === 'object' && !('additionalProperties' in schema)) {
    schema.additionalProperties = false;
  }
  if (schema.items) {
    ensureStrictSchema(Array.isArray(schema.items) ? schema.items[0] : schema.items);
  }
  for (const key of ['definitions', 'oneOf', 'anyOf', 'allOf', 'schema']) {
    if (schema[key] && Array.isArray(schema[key])) {
      schema[key].forEach(ensureStrictSchema);
    } else if (schema[key] && typeof schema[key] === 'object' && !Array.isArray(schema[key])) {
      if (key === 'schema') {
        ensureStrictSchema(schema[key]);
      } else {
        for (const k of Object.keys(schema[key])) {
          ensureStrictSchema(schema[key][k]);
        }
      }
    }
  }
}

/** Remove any key from required that is not in properties (safety net for "Extra required key" from OpenAI). */
function stripExtraRequired(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.properties && typeof schema.properties === 'object' && Array.isArray(schema.required)) {
    const propSet = new Set(Object.keys(schema.properties));
    schema.required = schema.required.filter((k) => propSet.has(k));
  }
  if (schema.properties) {
    for (const k of Object.keys(schema.properties)) {
      stripExtraRequired(schema.properties[k]);
    }
  }
  if (schema.items) {
    stripExtraRequired(Array.isArray(schema.items) ? schema.items[0] : schema.items);
  }
}

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
  // Doubled rates for OpenAI models (commercial pricing adjustment).
  'gpt-4': { input: 60.00, output: 120.00 },
  'gpt-4-turbo': { input: 20.00, output: 60.00 },
  'gpt-4o': { input: 10.00, output: 30.00 },
  'gpt-4o-mini': { input: 0.300, output: 1.200 },
  'gpt-5-mini': { input: 0.300, output: 1.200 },
  'gpt-5-nano': { input: 0.300, output: 1.200 },
  'gpt-3.5-turbo': { input: 1.00, output: 3.00 },
  'o1-preview': { input: 30.00, output: 120.00 },
  'o1-mini': { input: 6.00, output: 24.00 },
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
 * Report AI usage to backend so it can be estimated and charged.
 * This hits the backend's job AI metrics endpoint, which:
 * - calculates cost using admin-configured pricing (USD->AUD)
 * - deducts from user balance when required (ai.aionqa.com only)
 * - updates job AI metrics
 * @returns {Promise<{ usage?: { usd, aud }, deductedAud?: number, savedUsd?: number }|null>} Backend response or null
 */
async function reportAiMetricsToBackend(jobId, { usage, model }) {
  if (!jobId || !BACKEND_URL) {
    return null;
  }
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  try {
    const { data } = await axios.post(`${BACKEND_URL}/jobs/${encodeURIComponent(jobId)}/ai-metrics`, {
      usage,
      model,
      mode: AI_MODE
    }, {
      timeout: 5000
    });
    return data || null;
  } catch (error) {
    // Do not fail the AI call response if backend metering is unavailable.
    console.warn('[AI-SERVICE] Failed to report ai-metrics to backend:', error.response?.data?.error || error.message);
    return null;
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
// When true, check AI token balance with backend before each OpenAI request and deny if balance <= 0.
// Set only for the shared ai.aionqa.com deployment; leave unset for self-hosted / other AI services.
const REQUIRE_AI_BALANCE_CHECK = /^(true|1|yes)$/i.test(process.env.REQUIRE_AI_BALANCE_CHECK || '');

// Environment overrides: when set, take priority over request params (used by ai.aionqa.com)
const ENV_OVERRIDE_MODEL = process.env.OPENAI_OVERRIDE_MODEL || process.env.OPENAI_DEFAULT_MODEL;
const _envMax = process.env.OPENAI_OVERRIDE_MAX_OUTPUT_TOKENS;
const ENV_OVERRIDE_MAX_OUTPUT_TOKENS = (_envMax != null && _envMax !== '') ? (parseInt(_envMax, 10) || null) : null;
const ENV_OVERRIDE_REASONING = process.env.OPENAI_OVERRIDE_REASONING_ENABLED != null
  ? /^(true|1|yes)$/i.test(process.env.OPENAI_OVERRIDE_REASONING_ENABLED)
  : null; // null = not set, true/false = override
if (ENV_OVERRIDE_MODEL || ENV_OVERRIDE_MAX_OUTPUT_TOKENS != null || ENV_OVERRIDE_REASONING !== null) {
  console.log(`[AI-SERVICE] Environment overrides: model=${ENV_OVERRIDE_MODEL || 'none'}, max_output_tokens=${ENV_OVERRIDE_MAX_OUTPUT_TOKENS ?? 'none'}, reasoning_enabled=${ENV_OVERRIDE_REASONING}`);
}

app.post('/api/ai/chat', async (req, res) => {
  const startTime = Date.now();
  const {
    project_id,
    job_id,
    messages,
    input, // Responses API format (already in correct format)
    model: reqModel = 'gpt-5-mini',
    temperature,
    max_tokens,
    max_output_tokens,
    ...otherParams
  } = req.body;
  // Environment overrides take priority over request params
  const model = ENV_OVERRIDE_MODEL || reqModel;
  const effectiveMaxTokens = ENV_OVERRIDE_MAX_OUTPUT_TOKENS != null
    ? ENV_OVERRIDE_MAX_OUTPUT_TOKENS
    : (max_tokens !== undefined ? max_tokens : (max_output_tokens !== undefined ? max_output_tokens : 128000));

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
    // Step 1: Check eligibility (license/funds) — only for shared ai.aionqa.com (REQUIRE_AI_BALANCE_CHECK)
    if (REQUIRE_AI_BALANCE_CHECK && requestProjectId && requestJobId) {
      const eligibility = await checkEligibility(requestProjectId, requestJobId, model);
      if (!eligibility.eligible) {
        const balanceAud = eligibility.balance_aud ?? 0;
        const errorMsg = eligibility.reason === 'insufficient_funds'
          ? `Insufficient AI token balance. Please top up to continue. (Balance: ${Number(balanceAud).toFixed(2)} AUD)`
          : `Request not eligible: ${eligibility.reason || 'Unknown reason'}`;
        const reasonText = String(eligibility.reason || '').toLowerCase();
        const isTransientGatewayIssue =
          reasonText.includes('status code 502') ||
          reasonText.includes('status code 503') ||
          reasonText.includes('status code 504') ||
          reasonText.includes('bad gateway') ||
          reasonText.includes('gateway timeout');
        const logLevel = isTransientGatewayIssue ? 'warn' : 'error';
        console.warn(`[AI-SERVICE] ${errorMsg}`);

        await logToBackend(requestJobId, logLevel, `[AI] ${isTransientGatewayIssue ? '⚠️' : '❌'} ${errorMsg}`, {
          model,
          project_id: requestProjectId,
          eligibility,
        });

        const statusCode = eligibility.reason === 'insufficient_funds' ? 402 : 403;
        return res.status(statusCode).json({
          error: {
            message: errorMsg,
            type: 'eligibility_error',
            code: eligibility.reason === 'insufficient_funds' ? 'insufficient_funds' : 'not_eligible',
            eligibility,
          },
        });
      }
    }

    // Step 2: Log request start (use actualModel so logs show LM Studio/Ollama model when applicable)
    if (requestJobId) {
      await logToBackend(requestJobId, 'info', `[AI] 🤖 AI Request: Model: ${actualModel}, Mode: ${AI_MODE}`, {
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

    // Step 4: Make LLM API call based on mode (no retry - fail immediately; crawler may try next ai_service if multiple configured)
    let response;
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
        console.log(`[AI-SERVICE] Ollama request: ${messages.length} messages, model: ${ollamaModel}, format: ${ollamaFormat === 'json' ? 'json' : ollamaFormat ? 'schema' : 'none'}`);
        response = await llmClient.chat(messages, {
          model: ollamaModel,
          ...(ollamaFormat && { format: ollamaFormat })
        });
        response = convertChatToResponses(response);
      } else if (AI_MODE === 'lm-studio') {
        // LM Studio: only accepts response_format.type 'json_schema' or 'text' (not json_object)
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
          }
        }
        console.log(`[AI-SERVICE] LM Studio request: ${messages.length} messages, model: ${lmStudioModel}, response_format: ${responseFormat ? 'json_schema' : 'none'}`);
        response = await llmClient.chat(messages, {
          model: lmStudioModel,
          temperature: temperature !== undefined ? temperature : 0.7,
          max_tokens: effectiveMaxTokens,
          ...(responseFormat && { response_format: responseFormat }),
          ...otherParams
        });
        response = convertChatToResponses(response);
      } else {
        // OpenAI and OpenAI-compatible: use response_format (text.format) with json_schema, not response_schema (400 Unknown parameter)
        const { response_schema: responseSchema, reasoning: reqReasoning, reasoning_effort: reqReasoningEffort, ...openaiSafeParams } = otherParams;
        // Environment override for reasoning takes priority
        let reasoningObj;
        if (ENV_OVERRIDE_REASONING === false) {
          // gpt-5-nano does not support 'none', use 'minimal' (lowest effort)
          reasoningObj = { effort: 'minimal' };
          console.log(`[AI-SERVICE] Reasoning minimized by environment override: effort=minimal`);
        } else if (ENV_OVERRIDE_REASONING === true) {
          reasoningObj = { effort: reqReasoningEffort || 'medium' };
          console.log(`[AI-SERVICE] Reasoning enabled by environment override: effort=${reasoningObj.effort}`);
        } else {
          // Normalize reasoning for OpenAI Responses API: expects reasoning: { effort: "medium" } or { effort: "none" }
          const useReasoning = reqReasoning === true || (reqReasoning && typeof reqReasoning === 'object' && reqReasoning?.effort !== 'none');
          reasoningObj = useReasoning
            ? (typeof reqReasoning === 'object' && reqReasoning?.effort
                ? { effort: reqReasoning.effort === 'none' ? 'minimal' : reqReasoning.effort }
                : { effort: reqReasoningEffort || 'medium' })
            : undefined;
          // GPT-5 reasons by default; when disabled we must explicitly send effort: "none"
          const isGpt5OrReasoningModel = model && /^gpt-5|^gpt-4\.1|^o4/i.test(String(model));
          if (!reasoningObj && isGpt5OrReasoningModel) {
            // gpt-5-nano does not support 'none', use 'minimal' (lowest effort)
            reasoningObj = { effort: 'minimal' };
            console.log(`[AI-SERVICE] Reasoning minimized for GPT-5/4.1/o4: effort=minimal`);
          } else if (useReasoning && reasoningObj) {
            console.log(`[AI-SERVICE] OpenAI reasoning: effort=${reasoningObj.effort || 'medium'}`);
          }
        }
        const existingText = openaiSafeParams.text || {};
        let textFormat = existingText.format;
        if (responseSchema && typeof responseSchema === 'object' && (responseSchema.type === 'object' || responseSchema.schema)) {
          const rawSchema = JSON.parse(JSON.stringify(responseSchema.schema || responseSchema));
          ensureStrictSchema(rawSchema);
          stripExtraRequired(rawSchema);
          textFormat = {
            type: 'json_schema',
            name: responseSchema.name || 'response',
            schema: rawSchema,
            strict: true
          };
          console.log(`[AI-SERVICE] OpenAI request: using response_format (text.format) with json_schema`);
        }
        // OpenAI mode: always use json_schema (Responses API); no chat completions; require structured output
        if (AI_MODE === 'openai' && (!textFormat || textFormat.type !== 'json_schema')) {
          const defaultSchema = { type: 'object', properties: { content: { type: 'string' } }, additionalProperties: false };
          ensureStrictSchema(defaultSchema);
          stripExtraRequired(defaultSchema);
          textFormat = {
            type: 'json_schema',
            name: 'response',
            schema: defaultSchema,
            strict: true
          };
          console.log(`[AI-SERVICE] OpenAI mode: using default json_schema (required for Responses API)`);
        }
        // When requiring JSON: prepend strict instruction so model returns JSON only (no markdown)
        let requestInput = inputArray;
        if (textFormat && (textFormat.type === 'json_schema' || textFormat.type === 'json_object')) {
          const jsonOnlyPrefix = 'Respond with valid JSON only. No markdown, no code blocks.\n\n';
          let prepended = false;
          requestInput = inputArray.map((item) => {
            if (item.type !== 'message' || !Array.isArray(item.content) || prepended) return item;
            const content = item.content.map((c) => {
              if (!prepended && c.type === 'input_text' && typeof c.text === 'string') {
                prepended = true;
                if (!c.text.startsWith(jsonOnlyPrefix.trim())) {
                  return { ...c, text: jsonOnlyPrefix + c.text };
                }
              }
              return c;
            });
            return { ...item, content };
          });
        }
        const isGpt5 = model && String(model).toLowerCase().startsWith('gpt-5');
        const openaiRequest = {
          model,
          input: requestInput,
          ...(!isGpt5 && temperature !== undefined && { temperature }),
          ...(effectiveMaxTokens !== undefined && { max_output_tokens: effectiveMaxTokens }),
          ...(reasoningObj && { reasoning: reasoningObj }),
          ...openaiSafeParams,
          text: { ...existingText, format: textFormat }
        };
        if (isGpt5) {
          console.log(`[AI-SERVICE] GPT-5 model: using max_output_tokens, omitting temperature`);
        }
        if (AI_MODE === 'openai') {
          response = await llmClient.responses.create(openaiRequest);
        } else {
          try {
            response = await llmClient.responses.create(openaiRequest);
          } catch (error) {
            const messages = convertInputToMessages(inputArray);
            const wantsJson = otherParams.text?.format?.type === 'json_object';
            const { response_schema: _drop2, ...chatSafeParams } = otherParams;
            const chatResponse = await llmClient.chat.completions.create({
              model,
              messages,
              temperature,
              max_tokens: effectiveMaxTokens,
              ...(wantsJson && { response_format: { type: 'json_object' } }),
              ...chatSafeParams
            });
            response = convertChatToResponses(chatResponse);
          }
        }
      }
    } catch (error) {
      console.error(`[AI-SERVICE] ❌ LLM API call failed:`, error.message);
      if (error.response) {
        console.error(`  Status: ${error.response.status}`);
        console.error(`  Response data:`, JSON.stringify(error.response.data));
      }
      if (requestJobId) {
        await logToBackend(requestJobId, 'error',
          `[AI] ❌ AI request failed: ${error.message}`,
          {
            model: actualModel,
            project_id: requestProjectId,
            mode: AI_MODE,
            error: error.message,
            error_status: error.response?.status,
            error_data: error.response?.data,
            status: 'failed'
          }
        );
      }
      throw error;
    }

    // Step 5: Report usage to backend first so we get the actual charged/saved cost (admin-configured pricing).
    const duration = Date.now() - startTime;
    let metricsResponse = null;
    if (requestJobId) {
      metricsResponse = await reportAiMetricsToBackend(requestJobId, { usage: response.usage, model: response.model });
    }

    // Step 6: Log completion using backend-reported cost so job logs always show correct charge/saved amount.
    const inputTokens = response.usage?.prompt_tokens ?? response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? response.usage?.output_tokens ?? 0;
    const totalTokens = response.usage?.total_tokens ?? (inputTokens + outputTokens);
    const costUsd = metricsResponse?.usage?.usd;
    const savedUsd = metricsResponse?.savedUsd;
    const costForLog = costUsd != null ? costUsd : (savedUsd != null ? savedUsd : calculateCost(response.usage, response.model).totalCost);
    const costText = savedUsd != null && savedUsd > 0
      ? `Saved $${Number(savedUsd).toFixed(6)} USD (self-deployed, not charged)`
      : `Cost: $${Number(costForLog).toFixed(6)} USD`;

    if (requestJobId) {
      await logToBackend(requestJobId, 'info',
        `[AI] AI call completed [reporting service] - Duration: ${duration}ms, Tokens: ${totalTokens}, ${costText}`,
        {
          model: response.model,
          project_id: requestProjectId,
          mode: AI_MODE,
          duration_ms: duration,
          ...response.usage,
          ...(costUsd != null && { cost_usd: costUsd }),
          ...(savedUsd != null && savedUsd > 0 && { saved_usd: savedUsd }),
          status: 'completed'
        }
      );
    }

    console.log(`[AI-SERVICE] ✅ AI request completed - Job: ${requestJobId}, Duration: ${duration}ms, Tokens: ${totalTokens}`);

    // Step 7: Return response in OpenAI format; include cost_usd so crawlers can log accurate cost.
    const outText = typeof response.output_text === 'string' ? response.output_text : contentToString(response.choices?.[0]?.message?.content);
    res.json({
      id: response.id,
      model: response.model,
      output_text: outText || '',
      output: response.output?.length ? response.output : [{ type: 'output_text', text: outText || '' }],
      usage: response.usage,
      finish_reason: response.finish_reason || response.choices?.[0]?.finish_reason || 'stop',
      status: response.status || 'completed',
      ...(costUsd != null && { cost_usd: costUsd }),
      ...(savedUsd != null && savedUsd > 0 && { saved_usd: savedUsd }),
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[AI-SERVICE] ❌ AI request failed - Job: ${requestJobId}, Error:`, error.message);

    // Log error (use actualModel so job logs show correct model)
    if (requestJobId) {
      await logToBackend(requestJobId, 'error', 
        `[AI] ❌ AI request failed: ${error.message}`,
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
