/**
 * Generic Job Handler contract — the scheduler's equivalent of the Tool
 * Registry contract (see `lib/tools/types.ts`). A "job type" owns its own
 * payload shape and business logic; the scheduler (retry/backoff/webhook
 * delivery/persistence) is completely generic across all job types.
 */

export interface JobContext {
  botId: string;
}

export interface JobExecutionResult {
  /**
   * If present, this payload is delivered to the bot's webhook, wrapped
   * in an envelope that identifies the job's id/type/botId so the
   * receiving client can dispatch by type. If absent, the job is treated
   * as handled internally (e.g. a future periodic-cleanup job type) and
   * no webhook delivery is attempted.
   */
  webhookPayload?: Record<string, unknown>;
}

export interface JobHandler<TPayload = Record<string, unknown>> {
  /** Stable machine-readable identifier stored in jobs.type, e.g. "reminder". */
  type: string;
  description: string;
  execute(payload: TPayload, ctx: JobContext): Promise<JobExecutionResult>;
}
