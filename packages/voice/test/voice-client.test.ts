import { describe, expect, it, vi } from "vitest";
import { requestVoiceCompletion, requestVoiceTurn } from "../src/index.js";

describe("requestVoiceTurn", () => {
  it("parses a successful voice bridge response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          turnId: "turn-1",
          deduplicated: true,
          responseText: "Hello from Tango.",
          providerName: "codex",
          providerSessionId: "provider-session-1",
          warmStartUsed: true,
          providerUsedFailover: false
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const result = await requestVoiceTurn(
      {
        sessionId: "voice-main",
        agentId: "watson",
        transcript: "hello"
      },
      {
        endpoint: "http://127.0.0.1:8787/voice/turn",
        fetchImpl
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      turnId: "turn-1",
      deduplicated: true,
      responseText: "Hello from Tango.",
      providerName: "codex",
      providerSessionId: "provider-session-1",
      warmStartUsed: true,
      providerUsedFailover: false
    });
  });

  it("retries retryable bridge failures and surfaces retry callbacks", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            responseText: "Recovered.",
            providerName: "codex"
          }),
          { status: 200 }
        )
      );
    const onRetry = vi.fn();

    const result = await requestVoiceTurn(
      {
        sessionId: "voice-main",
        agentId: "watson",
        transcript: "hello again"
      },
      {
        endpoint: "http://127.0.0.1:8787/voice/turn",
        maxRetries: 1,
        retryBaseDelayMs: 0,
        fetchImpl,
        onRetry
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 1,
      delayMs: 0,
      error: expect.any(Error)
    });
    expect(result.responseText).toBe("Recovered.");
  });

  it("does not retry non-retryable bridge failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad request", { status: 400 }));

    await expect(
      requestVoiceTurn(
        {
          sessionId: "voice-main",
          agentId: "watson",
          transcript: "bad request case"
        },
        {
          endpoint: "http://127.0.0.1:8787/voice/turn",
          maxRetries: 2,
          retryBaseDelayMs: 0,
          fetchImpl
        }
      )
    ).rejects.toThrow("Voice bridge HTTP 400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("requestVoiceCompletion", () => {
  it("parses a successful completion bridge response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          text: "BEST: default",
          providerName: "claude-oauth"
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const result = await requestVoiceCompletion(
      {
        systemPrompt: "Pick the best channel.",
        messages: [{ role: "user", content: "general" }]
      },
      {
        endpoint: "http://127.0.0.1:8787/voice/completion",
        fetchImpl
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      text: "BEST: default",
      providerName: "claude-oauth"
    });
  });

  it("does not retry caller-aborted completion requests", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    await expect(
      requestVoiceCompletion(
        {
          messages: [{ role: "user", content: "hello" }]
        },
        {
          endpoint: "http://127.0.0.1:8787/voice/completion",
          maxRetries: 2,
          retryBaseDelayMs: 0,
          fetchImpl,
          signal: controller.signal
        }
      )
    ).rejects.toThrow(/aborted/i);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
