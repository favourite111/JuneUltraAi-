import type {
  ModelProvider,
  ModelCallOptions,
  ModelResponse,
  ModelProviderMetadata,
} from "./types.js";

export class MockModelProvider implements ModelProvider {
  private mockResponses: ModelResponse[] = [];
  private callCount = 0;

  constructor(mockResponses: ModelResponse[] = []) {
    this.mockResponses = mockResponses;
  }

  async generate(prompt: string, options?: ModelCallOptions): Promise<ModelResponse> {
    // For testing, return pre-configured responses sequentially
    const response = this.mockResponses[this.callCount % this.mockResponses.length];
    this.callCount++;
    return Promise.resolve(response);
  }

  getMetadata(): ModelProviderMetadata {
    return {
      name: "MockModelProvider",
      models: [{ id: "mock-model", capabilities: ["chat", "text-generation"] }],
    };
  }
}
