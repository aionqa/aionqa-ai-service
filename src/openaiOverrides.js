import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const OVERRIDE_KEYS = [
  'OPENAI_OVERRIDE_MODEL',
  'OPENAI_OVERRIDE_MAX_OUTPUT_TOKENS',
  'OPENAI_OVERRIDE_REASONING_ENABLED',
  'OPENAI_OVERRIDE_REASONING_EFFORT',
];

/** Latest successful merge from app-vars (may override process.env for same keys). */
const volatile = {};

let smClient;
function getClient(region) {
  if (!smClient) smClient = new SecretsManagerClient({ region: region || 'us-east-1' });
  return smClient;
}

/**
 * @param {string} secretId
 * @param {string} region
 */
export async function refreshOpenAiOverridesFromSecret(secretId, region) {
  if (!secretId) return;
  const out = await getClient(region).send(new GetSecretValueCommand({ SecretId: secretId }));
  const str = out.SecretString || '{}';
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || !parsed) return;
  for (const k of OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, k)) {
      volatile[k] = parsed[k] == null ? '' : String(parsed[k]);
    } else {
      delete volatile[k];
    }
  }
}

/**
 * @param {string} secretId
 * @param {string} region
 * @param {number} intervalMs
 */
export function startOpenAiOverridePolling(secretId, region, intervalMs) {
  const id = String(secretId || '').trim();
  if (!id) return;
  const interval = Math.max(15000, Number(intervalMs) || 45000);
  const run = () => {
    refreshOpenAiOverridesFromSecret(id, region).catch((err) => {
      console.warn('[AI-SERVICE] openai overrides secret refresh failed:', err?.message || err);
    });
  };
  run();
  setInterval(run, interval);
}

function valueFromVolatileOrEnv(key, env) {
  if (Object.prototype.hasOwnProperty.call(volatile, key)) {
    return volatile[key] == null ? '' : String(volatile[key]);
  }
  const e = env[key];
  return e == null ? '' : String(e);
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} reqModel
 */
export function getEffectiveModel(env, reqModel) {
  const raw = valueFromVolatileOrEnv('OPENAI_OVERRIDE_MODEL', env).trim();
  if (raw !== '') return raw;
  const d = (env.OPENAI_DEFAULT_MODEL && String(env.OPENAI_DEFAULT_MODEL).trim()) || '';
  if (d !== '') return d;
  return reqModel;
}

/**
 * @param {Record<string, string|undefined>} env
 */
export function getEffectiveMaxOutputTokens(env) {
  const raw = valueFromVolatileOrEnv('OPENAI_OVERRIDE_MAX_OUTPUT_TOKENS', env).trim();
  if (raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * @returns {null|boolean} null = do not override
 * @param {Record<string, string|undefined>} env
 */
export function getEffectiveReasoningEnabledOverride(env) {
  const raw = valueFromVolatileOrEnv('OPENAI_OVERRIDE_REASONING_ENABLED', env).trim();
  if (raw === '') return null;
  return /^(true|1|yes)$/i.test(raw);
}

/**
 * @param {Record<string, string|undefined>} env
 */
export function getEffectiveReasoningEffortFromEnvOverride(env) {
  const raw = valueFromVolatileOrEnv('OPENAI_OVERRIDE_REASONING_EFFORT', env).trim();
  if (raw === '') return null;
  return raw.toLowerCase();
}
