// Runtime stats — tracked in memory, reset on restart

export const stats = {
  startTime: Date.now(),
  totalRequests: 0,
  totalResponseTimeMs: 0,

  recordRequest(durationMs: number) {
    this.totalRequests++;
    this.totalResponseTimeMs += durationMs;
  },

  get uptimeMs() {
    return Date.now() - this.startTime;
  },

  get avgResponseTimeMs() {
    if (this.totalRequests === 0) return 0;
    return Math.round(this.totalResponseTimeMs / this.totalRequests);
  },
};
