/**
 * Eligibility Checker
 * Checks with backend if request is eligible (license/funds)
 */

import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || 'http://back:4000';

/** Match crawler OpenAI client: ALB/upstream blips before failing closed. */
const TRANSIENT_ELIGIBILITY_HTTP = new Set([408, 429, 502, 503, 504]);
/** Rolling deploys / ALB target drains can surface 502 longer than a couple of quick retries. */
const MAX_ELIGIBILITY_ATTEMPTS = 6;

const parsedEligibilityTimeout = parseInt(process.env.AI_ELIGIBILITY_CHECK_TIMEOUT_MS || '', 10);
const ELIGIBILITY_TIMEOUT_MS = Number.isFinite(parsedEligibilityTimeout) && parsedEligibilityTimeout >= 3000
  ? Math.min(120000, parsedEligibilityTimeout)
  : 20000;

function isTransientEligibilityHttpError(error) {
  const st = error?.response?.status;
  return st != null && TRANSIENT_ELIGIBILITY_HTTP.has(Number(st));
}

function isTransientEligibilityNetworkError(error) {
  const code = error?.code;
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

/**
 * Check if request is eligible to be processed
 */
export async function checkEligibility(projectId, jobId, model, estimatedTokens = null) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ELIGIBILITY_ATTEMPTS; attempt++) {
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
          timeout: ELIGIBILITY_TIMEOUT_MS
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
      lastError = error;
      const retryable =
        (isTransientEligibilityHttpError(error) || isTransientEligibilityNetworkError(error))
        && attempt < MAX_ELIGIBILITY_ATTEMPTS - 1;
      if (retryable) {
        const delayMs = Math.min(16000, 600 * 2 ** attempt);
        const st = error.response?.status ?? error?.code ?? '?';
        console.warn(
          `[ELIGIBILITY] Transient eligibility error (${st}); retry ${attempt + 1}/${MAX_ELIGIBILITY_ATTEMPTS - 1} in ${delayMs}ms...`
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      break;
    }
  }

  const error = lastError;
  console.error(`[ELIGIBILITY] Failed to check eligibility:`, error?.message);

  // If backend is unavailable, allow request (fail open for availability)
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT') {
    console.warn(`[ELIGIBILITY] Backend unavailable, allowing request (fail open)`);
    return {
      eligible: true,
      reason: 'backend_unavailable',
      license_valid: null,
      funds_available: null
    };
  }

  // Upstream gateway errors after all retries: same class of unavailability as connection failures
  // during ECS/ALB rollouts (observed as 502 on /api/ai/check-eligibility).
  const gatewayStatus = error?.response?.status != null ? Number(error.response.status) : null;
  if (gatewayStatus === 502 || gatewayStatus === 503 || gatewayStatus === 504) {
    console.warn(
      `[ELIGIBILITY] Gateway/status ${gatewayStatus} from backend after ${MAX_ELIGIBILITY_ATTEMPTS} attempts; allowing request (fail-open for deploy blips)`
    );
    return {
      eligible: true,
      reason: 'eligibility_gateway_transient',
      license_valid: null,
      funds_available: null
    };
  }

  // For other errors, deny request (fail closed for security)
  return {
    eligible: false,
    reason: error?.response?.data?.error || error?.message,
    license_valid: false,
    funds_available: false
  };
}
