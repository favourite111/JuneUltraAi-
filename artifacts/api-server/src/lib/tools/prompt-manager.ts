import type { ExecutionContext, LLMDecision, PromptManager, Tool } from "./types.js";

export class ConcretePromptManager implements PromptManager {
  renderPrompt(context: ExecutionContext, availableTools: Tool[]): string {
    const toolDescriptions = availableTools
      .filter((tool) => tool.manifest)
      .map((tool) => {
        const manifest = tool.manifest!;
        return `Tool Name: ${manifest.name}
Description: ${manifest.description}
Input Schema: ${JSON.stringify(manifest.inputSchema)}
`;
      })
      .join("\n");

    return `You are an AI assistant that helps users by selecting the best tool to fulfill their requests.

Available Tools:
${toolDescriptions}

User Request: ${context.conversation.key}

Based on the user's request and the available tools, please respond with a JSON object that represents your decision. The JSON object must conform to the LLMDecision interface:

interface LLMDecision {
  type: 'tool_selection' | 'clarification' | 'no_action';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  reasoning: string;
  confidence?: number;
  clarificationQuestion?: string;
}

- If you are confident that a tool can fulfill the request, set 'type' to 'tool_selection', provide the 'toolName', 'toolArgs', and a 'confidence' score (0.0-1.0).
- If you need more information from the user to select a tool, set 'type' to 'clarification' and provide a 'clarificationQuestion'.
- If no tool is suitable and no clarification is needed, set 'type' to 'no_action'.

Your JSON response:
`;
  }

  parseResponse(llmResponse: string): LLMDecision {
    try {
      const decision = JSON.parse(llmResponse) as LLMDecision;
      // Basic validation to ensure the parsed object conforms to LLMDecision structure
      if (!decision || !decision.type || typeof decision.reasoning !== 'string') {
        throw new Error('Invalid LLMDecision structure');
      }
      return decision;
    } catch (error) {
      console.error('Failed to parse LLM response:', error);
      return {
        type: 'no_action',
        reasoning: `Failed to parse LLM response: ${llmResponse}`,
        confidence: 0,
      };
    }
  }
}
