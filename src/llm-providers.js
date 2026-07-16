/**
 * LLM Provider Factory
 * Supports multiple LLM backends: OpenAI, OpenAI-compatible, LM Studio
 */

import OpenAI from 'openai';
import axios from 'axios';

/**
 * Create LLM client based on mode.
 * For openai mode, config.apiKey (or OPENAI_API_KEY) is required unless allowMissingApiKey is true
 * (shared ai.aionqa.com starts without a platform key and uses per-request BYOK).
 */
export function createLLMClient(mode, config = {}, options = {}) {
  switch (mode) {
    case 'openai':
      return createOpenAIClient(config, options);
    case 'openai-compatible':
      return createOpenAICompatibleClient(config);
    case 'lm-studio':
      return createLMStudioClient(config);
    case 'ollama':
      return createOllamaClient(config);
    default:
      throw new Error(`Unsupported LLM mode: ${mode}`);
  }
}

/**
 * OpenAI client (direct OpenAI API)
 */
function createOpenAIClient(config, options = {}) {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (options.allowMissingApiKey) {
      return null;
    }
    throw new Error('OPENAI_API_KEY is required for OpenAI mode (set env for self-hosted AI, or pass openai_api_key per request)');
  }
  
  return new OpenAI({
    apiKey: apiKey,
    baseURL: config.baseURL || 'https://api.openai.com/v1'
  });
}

/**
 * OpenAI-compatible client (any API that follows OpenAI format)
 */
function createOpenAICompatibleClient(config) {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || 'not-needed';
  const baseURL = config.baseURL || config.url || process.env.LLM_BASE_URL;
  
  if (!baseURL) {
    throw new Error('LLM_BASE_URL is required for openai-compatible mode');
  }
  
  return new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL
  });
}

/**
 * LM Studio client - OpenAI-compatible /v1/chat/completions (per LM Studio docs)
 */
function createLMStudioClient(config) {
  const baseURL = config.url || process.env.LM_STUDIO_URL || 'http://localhost:1234';
  const apiKey = config.apiKey || process.env.LM_STUDIO_API_KEY || null;
  
  return {
    baseURL,
    apiKey,
    async chat(messages, options = {}) {
      const response = await axios.post(
        `${baseURL}/v1/chat/completions`,
        {
          model: options.model || 'local-model',
          messages,
          temperature: options.temperature,
          max_tokens: options.max_tokens,
          ...options
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey && { 'Authorization': `Bearer ${apiKey}` })
          },
          timeout: 900000
        }
      );
      return response.data;
    }
  };
}

/**
 * Ollama client - native POST /api/chat (per https://docs.ollama.com/api/chat)
 * Supports format: 'json' or a JSON schema object for structured output (docs.ollama.com/capabilities/structured-outputs)
 */
function createOllamaClient(config) {
  const baseURL = (config.url || process.env.OLLAMA_URL || process.env.LM_STUDIO_URL || 'http://localhost:11434').replace(/\/$/, '');
  
  return {
    baseURL,
    async chat(messages, options = {}) {
      const model = options.model || process.env.OLLAMA_MODEL || 'llama3.2';
      const body = {
        model,
        messages,
        stream: false
      };
      if (options.format !== undefined) {
        body.format = options.format;
      }
      const response = await axios.post(
        `${baseURL}/api/chat`,
        body,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 900000
        }
      );
      const data = response.data;
      // Map Ollama response to OpenAI-like shape for convertChatToResponses
      return {
        id: `chatcmpl-${Date.now()}`,
        model: data.model || model,
        choices: [{
          message: { role: 'assistant', content: data.message?.content || '' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: data.prompt_eval_count ?? 0,
          completion_tokens: data.eval_count ?? 0,
          total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0)
        }
      };
    }
  };
}

/**
 * Convert OpenAI Responses API input format to chat messages
 * Handles both Responses API format (input array) and Chat API format (messages array)
 */
function convertInputToMessages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return [{ role: 'user', content: 'Hello' }];
  }
  
  // Check if already in Chat API format (has 'role' and 'content' as string)
  if (input[0] && typeof input[0].content === 'string' && input[0].role) {
    // Already in Chat API format, return as-is
    return input.map(msg => ({
      role: msg.role || 'user',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    }));
  }
  
  // Convert from Responses API format (input array with type: 'message')
  return input.map(item => {
    if (item.type === 'message') {
      const content = item.content || [];
      // Handle content array (Responses API format)
      if (Array.isArray(content)) {
        const textParts = content
          .filter(c => c && (c.type === 'input_text' || c.type === 'text'))
          .map(c => c.text || c.content || '')
          .filter(text => text.length > 0)
          .join('\n');
        
        return {
          role: item.role || 'user',
          content: textParts || 'Hello'
        };
      } else if (typeof content === 'string') {
        // Content is already a string
        return {
          role: item.role || 'user',
          content: content
        };
      }
    }
    // Fallback: try to extract content from item
    if (item.content && typeof item.content === 'string') {
      return {
        role: item.role || 'user',
        content: item.content
      };
    }
    return { role: 'user', content: 'Hello' };
  });
}

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
