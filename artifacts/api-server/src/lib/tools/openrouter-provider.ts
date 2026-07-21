import { OpenAI } from "openai";
import type { ModelCallOptions, ModelProvider, ModelProviderMetadata, ModelResponse } from "./types.js";

export class OpenRouterModelProvider implements ModelProvider {
  private client: OpenAI;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel: string = process.env.OPENROUTER_MODEL || "openai/gpt-4o") {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });
    this.defaultModel = defaultModel;
  }

  async generate(prompt: string, options?: ModelCallOptions): Promise<ModelResponse> {
    const model = options?.model || this.defaultModel;
    const timeout = options?.timeout ?? 4000; // Default to 4 seconds
    const retryAttempts = options?.retryAttempts ?? 1; // Default to 1 retry

    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);

        const completion = await this.client.chat.completions.create({
          model: model,
          messages: [{ role: "user", content: prompt }],
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? 500,
          stop: options?.stopSequences,
        }, { signal: controller.signal });

        clearTimeout(id);
        return { text: completion.choices[0]?.message?.content || "" };
      } catch (error: any) {
        if (error.name === "AbortError") {
          console.warn(`LLM call timed out after ${timeout}ms (attempt ${attempt + 1}/${retryAttempts + 1})`);
        } else {
          console.error(`LLM call failed (attempt ${attempt + 1}/${retryAttempts + 1}):`, error);
        }
        if (attempt === retryAttempts) {
          throw error; // Re-throw if all retries fail
        }
      }
    }
    throw new Error("Unexpected error in OpenRouterModelProvider.generate");
  }

  getMetadata(): ModelProviderMetadata {
    return {
      name: "OpenRouter",
      models: [{ id: this.defaultModel, capabilities: ["chat", "text-generation"] }],
    };
  }
}
