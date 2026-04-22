/**
 * Batches job log lines for AI-SERVICE before POSTing to the backend append-ai endpoint.
 * Separate SQS event type (logs.jobs.append.ai) from main crawler logs.
 */
import axios from 'axios';

const INTERVAL_SEC = Math.min(
  300,
  Math.max(10, Number(process.env.AI_LOG_CHUNK_FLUSH_INTERVAL_SEC || 30) || 30)
);
const MAX_LINES_PER_REQUEST = 200;

/** @type {Map<string, object[]>} */
const buffers = new Map();
let flushTimer = null;
let backendBase = '';

function splitBatches(arr, maxPer) {
  const batches = [];
  for (let i = 0; i < arr.length; i += maxPer) {
    batches.push(arr.slice(i, i + maxPer));
  }
  return batches.length ? batches : [[]];
}

export function setAiJobLogBackendUrl(url) {
  backendBase = String(url || '').trim().replace(/\/+$/, '');
}

function ensureTimer() {
  if (flushTimer != null || !backendBase) return;
  flushTimer = setInterval(() => {
    flushAiJobLogBuffers().catch((err) => console.warn('[AI-SERVICE] log buffer flush:', err.message));
  }, INTERVAL_SEC * 1000);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Queue one AI-SERVICE line; flushed periodically or via {@link flushAiJobLogBuffers}.
 */
export function queueAiServiceJobLog(jobId, level, message, metadata = {}) {
  if (!jobId || !backendBase) return;
  const jid = String(jobId);
  if (!buffers.has(jid)) buffers.set(jid, []);
  buffers.get(jid).push({
    level,
    message,
    component: 'AI-SERVICE',
    metadata: metadata || {},
    timestamp: new Date().toISOString(),
  });
  ensureTimer();
}

export async function flushAiJobLogBuffers() {
  if (!backendBase) return;
  const url = `${backendBase}/api/logs/jobs/append-ai`;
  for (const [jobId, lines] of [...buffers.entries()]) {
    if (!lines.length) {
      buffers.delete(jobId);
      continue;
    }
    const chunk = lines.splice(0, lines.length);
    if (!chunk.length) {
      buffers.delete(jobId);
      continue;
    }
    for (const batch of splitBatches(chunk, MAX_LINES_PER_REQUEST)) {
      if (!batch.length) continue;
      try {
        await axios.post(url, { jobId, entries: batch }, { timeout: 20000 });
      } catch (e) {
        console.warn('[AI-SERVICE] append-ai batch failed:', e.message);
      }
    }
    if (!lines.length) buffers.delete(jobId);
  }
}
