import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicClient } from "./anthropic-client";

afterEach(() => vi.restoreAllMocks());

describe("anthropicClient", () => {
  it("builds a tool-use request using the env key and returns the tool input ops", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "emit_mutations",
                input: { ops: [{ op: "removeContentType", name: "X" }] },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ops = await anthropicClient().propose({ system: "sys", user: "usr" });

    expect(ops).toEqual([{ op: "removeContentType", name: "X" }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("api.anthropic.com");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const body = JSON.parse(init!.body as string);
    expect(body.system).toBe("sys");
    expect(body.tools[0].name).toBe("emit_mutations");
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_mutations" });
  });
  it("throws when the key is absent", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(anthropicClient().propose({ system: "s", user: "u" })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
