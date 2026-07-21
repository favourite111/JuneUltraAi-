import type { ExecutionContext, LLMDecision, PromptManager, Tool } from "./types.js";

export class MockPromptManager implements PromptManager {
  private responses: LLMDecision[];

  constructor(responses: LLMDecision[] = []) {
    this.responses = responses;
  }

  renderPrompt(context: ExecutionContext, availableTools: Tool[]): string {
    // For mock, we don't need to render a complex prompt, just return a placeholder
    return "mock-prompt";
  }

  parseResponse(llmResponse: string): LLMDecision {
    if (this.responses.length > 0) {
      return this.responses.shift()!;
    }
    // Fallback for unexpected calls
    return {
      type: "no_action",
      reasoning: "MockPromptManager has no more responses",
      confidence: 0,
    };
  }
}
