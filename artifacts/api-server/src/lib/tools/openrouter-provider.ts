import { OpenAI } from "openai";
import type {
  ModelProvider,
  ModelCallOptions,
  ModelResponse,
  ModelProviderMetadata,
} from "./types.js";

export class OpenRouterModelProvider implements ModelProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });
    this.model = model;
  }

  async generate(prompt: string, options?: ModelCallOptions): Promise<ModelResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 500,
      stop: options?.stopSequences,
    });

    const text = completion.choices[0]?.message?.content || "";
    return { text };
  }

  getMetadata(): ModelProviderMetadata {
    return {
      name: "OpenRouter",
      models: [{ id: this.model, capabilities: ["chat", "text-generation"] }],
    };
  }
}
