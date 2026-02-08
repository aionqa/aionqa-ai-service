/**
 * LLM Provider Factory
 * Supports multiple LLM backends: OpenAI, OpenAI-compatible, LM Studio
 */

import OpenAI from 'openai';
import axios from 'axios';

/**
 * Create LLM client based on mode
 */
export function createLLMClient(mode, config) {
  switch (mode) {
    case 'openai':
      return createOpenAIClient(config);
    case 'openai-compatible':
      return createOpenAICompatibleClient(config);
    case 'lm-studio':
      return createLMStudioClient(config);
    default:
      throw new Error(`Unsupported LLM mode: ${mode}`);
  }
}

/**
 * OpenAI client (direct OpenAI API)
 */
function createOpenAIClient(config) {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for OpenAI mode');
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
 * LM Studio client (HTTP API format)
 */
function createLMStudioClient(config) {
  const baseURL = config.url || process.env.LM_STUDIO_URL || 'http://localhost:1234';
  const apiKey = config.apiKey || process.env.LM_STUDIO_API_KEY || null;
  
  return {
    baseURL,
    apiKey,
    // Custom implementation for LM Studio / Ollama (OpenAI-compatible)
    // Do not send model: server uses its loaded/default model per public API usage.
    async chat(messages, options = {}) {
      const { model, ...restOptions } = options;
      const response = await axios.post(
        `${baseURL}/v1/chat/completions`,
        {
          messages,
          ...(restOptions.temperature !== undefined && { temperature: restOptions.temperature }),
          ...(restOptions.max_tokens !== undefined && { max_tokens: restOptions.max_tokens }),
          ...restOptions
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey && { 'Authorization': `Bearer ${apiKey}` })
          },
          timeout: 900000 // 15 minutes timeout for AI requests
        }
      );
      
      return response.data;
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

/**
 * Convert chat completion response to Responses API format
 */
function convertChatToResponses(chatResponse) {
  const choice = chatResponse.choices?.[0];
  const message = choice?.message;
  
  return {
    id: chatResponse.id || `chatcmpl-${Date.now()}`,
    model: chatResponse.model,
    output_text: message?.content || '',
    output: [
      {
        type: 'output_text',
        text: message?.content || ''
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
