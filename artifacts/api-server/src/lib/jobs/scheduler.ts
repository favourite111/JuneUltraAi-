/**
 * Generic job scheduler — sweeps due jobs, dispatches each to its
 * registered handler by `type`, and (for handlers that return a
 * webhookPayload) delivers a signed webhook to the owning bot. Retry
 * policy, backoff, and delivery-history bookkeeping are all handled here,
 * once, for every job type — handlers never implement their own retry
 * logic.
 */

import { claimDueJobs, markDelivered, markRetry, markFailed, type JobRecord, type DeliveryLogEntry } from "../job-store.js";
import { getBotWebhookConfig } from "../bot-registry.js";
import { signWebhookPayload } from "../crypto.js";
import { getJobHandler } from "./registry.js";
import { logger } from "../logger.js";

const SWEEP_INTERVAL_MS = 60 * 1000; // every minute
// 1m, 5m, 15m -- matches the "3 retries, exponential backoff" policy.
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

interface DeliveryOutcome {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

async function deliverWebhook(
  job: JobRecord,
  webhookPayload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const config = await getBotWebhookConfig(job.botId);
  if (!config) {
    return { ok: false, error: "Bot has no webhook configured" };
  }

  // The envelope always identifies the job type, so a bot subscribed to
  // multiple kinds of scheduled events (reminders, broadcasts, ...) can
  // dispatch on `type` without guessing from the shape of `data`.
  const envelope = {
    jobId: job.id,
    type: job.type,
    botId: job.botId,
    deliveredAt: new Date().toISOString(),
    data: webhookPayload,
  };
  const rawBody = JSON.stringify(envelope);
  const signature = signWebhookPayload(config.webhookSecret, rawBody);

  try {
    const res = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": `sha256=${signature}` },
      body: rawBody,
    });

    if (!res.ok) {
      return { ok: false, statusCode: res.status, error: `Webhook responded with status ${res.status}` };
    }
    return { ok: true, statusCode: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleFailureOrRetry(
  job: JobRecord,
  attemptNumber: number,
  error: string,
  statusCode?: number,
): Promise<void> {
  const logEntry: DeliveryLogEntry = {
    attempt: attemptNumber,
    at: new Date().toISOString(),
    success: false,
    ...(statusCode !== undefined ? { statusCode } : {}),
    error,
  };

  if (attemptNumber >= job.maxAttempts) {
    await markFailed(job.id, error, logEntry);
    logger.error({ jobId: job.id, type: job.type, attempts: attemptNumber, error }, "Job failed permanently");
    return;
  }

  const backoff = RETRY_BACKOFF_MS[attemptNumber - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
  const nextDueAt = new Date(Date.now() + backoff);
  await markRetry(job.id, nextDueAt, error, logEntry);
  logger.info({ jobId: job.id, type: job.type, attempt: attemptNumber, nextDueAt }, "Job scheduled for retry");
}

async function processJob(job: JobRecord): Promise<void> {
  const handler = getJobHandler(job.type);
  const attemptNumber = job.attempts + 1;

  if (!handler) {
    // Forward-compatible: an unrecognized type (e.g. a job created by a
    // newer version of this service, or a bug) fails that one job instead
    // of crashing the sweep for everything else.
    await markFailed(job.id, `No handler registered for job type "${job.type}"`);
    logger.error({ jobId: job.id, type: job.type }, "Job has no registered handler");
    return;
  }

  let result;
  try {
    result = await handler.execute(job.payload, { botId: job.botId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await handleFailureOrRetry(job, attemptNumber, message);
    return;
  }

  if (!result.webhookPayload) {
    // Internal-only job type (nothing to deliver) -- executing it successfully is enough.
    await markDelivered(job.id, { attempt: attemptNumber, at: new Date().toISOString(), success: true });
    return;
  }

  const delivery = await deliverWebhook(job, result.webhookPayload);
  if (delivery.ok) {
    await markDelivered(job.id, {
      attempt: attemptNumber,
      at: new Date().toISOString(),
      success: true,
      ...(delivery.statusCode !== undefined ? { statusCode: delivery.statusCode } : {}),
    });
  } else {
    await handleFailureOrRetry(job, attemptNumber, delivery.error ?? "Unknown delivery error", delivery.statusCode);
  }
}

export async function runJobSweep(): Promise<void> {
  try {
    const jobs = await claimDueJobs();
    if (jobs.length === 0) return;

    logger.info({ count: jobs.length }, "Processing due jobs");
    await Promise.all(jobs.map((job) => processJob(job)));
  } catch (err) {
    logger.error({ err }, "Job sweep failed");
  }
}

export function startScheduler(): void {
  runJobSweep();
  setInterval(runJobSweep, SWEEP_INTERVAL_MS).unref();
}
