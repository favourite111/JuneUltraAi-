import type {
  PromptManager,
  ExecutionContext,
  Tool,
  LLMDecision,
  ReflectionDecisionType,
} from "./types.js";

export class MockPromptManager implements PromptManager {
  private mockDecisions: LLMDecision[] = [];
  private callCount = 0;

  constructor(mockDecisions: LLMDecision[] = []) {
    this.mockDecisions = mockDecisions;
  }

  renderPrompt(context: ExecutionContext, availableTools: Tool[]): string {
    // For testing, we can just return a simple prompt or inspect the context/tools
    return `User: ${context.user.id}, Prompt: ${context.conversation.state}, Tools: ${availableTools.map(t => t.name).join(', ')}`;
  }

  parseResponse(llmResponse: string): LLMDecision {
    // For testing, return pre-configured decisions sequentially
    const decision = this.mockDecisions[this.callCount % this.mockDecisions.length];
    this.callCount++;
    return decision;
  }
}
