import type { AiClient } from "./client";

interface ToolUseBlock {
  type: string;
  input?: { ops?: unknown };
}

// The tool input schema is deliberately permissive — author()'s `mutations.safeParse` is the real gate.
const TOOL = {
  name: "emit_mutations",
  description: "Return the array of mutation ops to apply to the content model.",
  input_schema: {
    type: "object",
    properties: { ops: { type: "array", items: { type: "object" } } },
    required: ["ops"],
  },
};

export const anthropicClient = (opts: { model?: string } = {}): AiClient => ({
  async propose({ system, user }) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? "claude-sonnet-4-6",
        max_tokens: 4096,
        system,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "emit_mutations" },
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: ToolUseBlock[] };
    const tool = data.content.find((b) => b.type === "tool_use");
    return tool?.input?.ops;
  },
});
