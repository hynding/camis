// The LLM seam. The core depends only on this; the real impl is anthropic-client.ts.
export interface AiClient {
  propose(input: { system: string; user: string }): Promise<unknown>;
}
