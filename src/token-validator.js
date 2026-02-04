/**
 * Token Validator
 * Validates 24-hour AI service tokens issued by backend
 */

import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

// Cache for validated tokens (token -> { valid: boolean, expires: number, project_id: string })
const tokenCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache

/**
 * Validate AI service token with backend
 */
export async function validateAIServiceToken(token) {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && cached.expires > Date.now()) {
    return {
      valid: cached.valid,
      project_id: cached.project_id,
      job_id: cached.job_id
    };
  }
  
  try {
    const response = await axios.get(
      `${BACKEND_URL}/api/ai/validate-token`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        },
        timeout: 5000
      }
    );
    
    const result = {
      valid: response.status === 200,
      project_id: response.data?.project_id || null,
      job_id: response.data?.job_id || null,
      expires_at: response.data?.expires_at || null
    };
    
    // Cache result (expires in 1 minute or when token expires, whichever is sooner)
    const cacheExpiry = result.expires_at 
      ? Math.min(Date.now() + CACHE_TTL, new Date(result.expires_at).getTime())
      : Date.now() + CACHE_TTL;
    
    tokenCache.set(token, {
      valid: result.valid,
      expires: cacheExpiry,
      project_id: result.project_id,
      job_id: result.job_id
    });
    
    return result;
  } catch (error) {
    console.warn(`[TOKEN-VALIDATOR] Token validation failed:`, error.message);
    
    // Cache negative result for 1 minute
    tokenCache.set(token, {
      valid: false,
      expires: Date.now() + CACHE_TTL,
      project_id: null,
      job_id: null
    });
    
    return {
      valid: false,
      project_id: null,
      job_id: null
    };
  }
}

/**
 * Clear expired tokens from cache
 */
export function clearExpiredTokens() {
  const now = Date.now();
  for (const [token, data] of tokenCache.entries()) {
    if (data.expires <= now) {
      tokenCache.delete(token);
    }
  }
}

// Clean up cache every 5 minutes
setInterval(clearExpiredTokens, 5 * 60 * 1000);
