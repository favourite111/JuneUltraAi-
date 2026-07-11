/**
 * Generic job store — Neon-backed, one row per scheduled task. This module
 * (and the `jobs` table) is deliberately type-agnostic: it knows nothing
 * about reminders, broadcasts, or any other job type. `type` is just a
 * string column the scheduler uses to look up a handler (see
 * `lib/jobs/registry.ts`). Adding a new kind of scheduled task never
 * requires touching this file.
 */

import { randomUUID } from "node:crypto";
import { getSql } from "./db.js";

export type JobStatus = "pending" | "processing" | "delivered" | "failed" | "cancelled";

export interface DeliveryLogEntry {
  attempt: number;
  /** ISO timestamp */
  at: string;
  success: boolean;
  statusCode?: number;
  error?: string;
}

export interface JobRecord<TPayload = Record<string, unknown>> {
  id: string;
  botId: string;
  type: string;
  payload: TPayload;
  dueAt: Date;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  deliveryLog: DeliveryLogEntry[];
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface JobRow {
  id: string;
  bot_id: string;
  type: string;
  payload: Record<string, unknown>;
  due_at: Date;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  delivery_log: DeliveryLogEntry[];
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    botId: row.bot_id,
    type: row.type,
    payload: row.payload,
    dueAt: row.due_at,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    deliveryLog: row.delivery_log ?? [],
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createJob(
  botId: string,
  type: string,
  payload: Record<string, unknown>,
  dueAt: Date,
  maxAttempts = 3,
): Promise<JobRecord> {
  const sql = getSql();
  const id = randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payloadJson = sql.json(payload as any);

  const rows = await sql<JobRow[]>`
    INSERT INTO jobs (id, bot_id, type, payload, due_at, max_attempts)
    VALUES (${id}, ${botId}, ${type}, ${payloadJson}, ${dueAt}, ${maxAttempts})
    RETURNING *
  `;

  return toJobRecord(rows[0]!);
}

/**
 * Atomically claims up to `limit` due jobs by flipping them to
 * "processing" (via `FOR UPDATE SKIP LOCKED`), so concurrent sweeps —
 * or a future multi-instance deploy — never double-run the same job.
 */
export async function claimDueJobs(limit = 20): Promise<JobRecord[]> {
  const sql = getSql();
  const rows = await sql<JobRow[]>`
    WITH due AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND due_at <= NOW()
      ORDER BY due_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
    SET status = 'processing', updated_at = NOW()
    FROM due
    WHERE jobs.id = due.id
    RETURNING jobs.*
  `;
  return rows.map(toJobRecord);
}

export async function markDelivered(jobId: string, logEntry: DeliveryLogEntry): Promise<void> {
  const sql = getSql();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logJson = sql.json([logEntry] as any);
  await sql`
    UPDATE jobs
    SET status = 'delivered',
        delivered_at = NOW(),
        attempts = attempts + 1,
        delivery_log = delivery_log || ${logJson},
        updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

export async function markRetry(
  jobId: string,
  nextDueAt: Date,
  error: string,
  logEntry: DeliveryLogEntry,
): Promise<void> {
  const sql = getSql();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logJson = sql.json([logEntry] as any);
  await sql`
    UPDATE jobs
    SET status = 'pending',
        due_at = ${nextDueAt},
        attempts = attempts + 1,
        last_error = ${error},
        delivery_log = delivery_log || ${logJson},
        updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

export async function markFailed(
  jobId: string,
  error: string,
  logEntry?: DeliveryLogEntry,
): Promise<void> {
  const sql = getSql();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logJson = sql.json((logEntry ? [logEntry] : []) as any);
  await sql`
    UPDATE jobs
    SET status = 'failed',
        attempts = attempts + 1,
        last_error = ${error},
        delivery_log = delivery_log || ${logJson},
        updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

export async function listJobsForBot(
  botId: string,
  type?: string,
  status?: JobStatus,
): Promise<JobRecord[]> {
  const sql = getSql();
  const rows = await sql<JobRow[]>`
    SELECT * FROM jobs
    WHERE bot_id = ${botId}
      ${type ? sql`AND type = ${type}` : sql``}
      ${status ? sql`AND status = ${status}` : sql``}
    ORDER BY due_at ASC
  `;
  return rows.map(toJobRecord);
}

/** Cancels a still-pending job. Returns false if it doesn't exist, isn't this bot's, or already ran. */
export async function cancelJob(jobId: string, botId: string): Promise<boolean> {
  const sql = getSql();
  const result = await sql`
    UPDATE jobs SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${jobId} AND bot_id = ${botId} AND status = 'pending'
    RETURNING id
  `;
  return result.length > 0;
}
