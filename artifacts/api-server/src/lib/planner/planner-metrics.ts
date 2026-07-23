export interface PlannerMetricsSnapshot {
  readonly plans_created: number;
  readonly tool_plans: number;
  readonly clarification_plans: number;
  readonly memory_plans: number;
  readonly average_plan_steps: number;
}

export class PlannerMetrics {
  private plansCreated = 0;
  private toolPlans = 0;
  private clarificationPlans = 0;
  private memoryPlans = 0;
  private totalPlanSteps = 0;

  record(result: { needsTool: boolean; needsClarification: boolean; needsMemory: boolean; plan: readonly unknown[] }): void {
    this.plansCreated += 1;
    this.totalPlanSteps += result.plan.length;
    if (result.needsTool) this.toolPlans += 1;
    if (result.needsClarification) this.clarificationPlans += 1;
    if (result.needsMemory) this.memoryPlans += 1;
  }

  snapshot(): PlannerMetricsSnapshot {
    return Object.freeze({
      plans_created: this.plansCreated,
      tool_plans: this.toolPlans,
      clarification_plans: this.clarificationPlans,
      memory_plans: this.memoryPlans,
      average_plan_steps: this.plansCreated === 0 ? 0 : this.totalPlanSteps / this.plansCreated,
    });
  }

  reset(): void {
    this.plansCreated = 0;
    this.toolPlans = 0;
    this.clarificationPlans = 0;
    this.memoryPlans = 0;
    this.totalPlanSteps = 0;
  }
}

export const plannerMetrics = new PlannerMetrics();