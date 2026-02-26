/**
 * Eligibility Checker
 * Checks with backend if request is eligible (license/funds)
 */

import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

/**
 * Check if request is eligible to be processed
 */
export async function checkEligibility(projectId, jobId, model, estimatedTokens = null) {
  try {
    const response = await axios.post(
      `${BACKEND_URL}/api/ai/check-eligibility`,
      {
        project_id: projectId,
        job_id: jobId,
        model: model,
        estimated_tokens: estimatedTokens
      },
      {
        timeout: 5000
      }
    );
    
    return {
      eligible: response.data.eligible === true,
      reason: response.data.reason || null,
      license_valid: response.data.license_valid,
      funds_available: response.data.funds_available,
      balance_aud: response.data.balance_aud != null ? Number(response.data.balance_aud) : null,
    };
  } catch (error) {
    console.error(`[ELIGIBILITY] Failed to check eligibility:`, error.message);
    
    // If backend is unavailable, allow request (fail open for availability)
    // But log the error
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      console.warn(`[ELIGIBILITY] Backend unavailable, allowing request (fail open)`);
      return {
        eligible: true,
        reason: 'backend_unavailable',
        license_valid: null,
        funds_available: null
      };
    }
    
    // For other errors, deny request (fail closed for security)
    return {
      eligible: false,
      reason: error.response?.data?.error || error.message,
      license_valid: false,
      funds_available: false
    };
  }
}
