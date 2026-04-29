import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackTools } from "../src/slack-tools.js";

vi.mock("../src/op-secret.js", () => ({
  getSecret: vi.fn(async (_vault: string, item: string) => {
    if (item === "Watson Slack User Token") return "xoxp-user";
    if (item === "Watson Slack Bot Token") return "xoxb-bot";
    return null;
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("slack tool", () => {
  it("filters saved items by date_create before expanding messages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T12:00:00Z"));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/stars.list")) {
        return new Response(JSON.stringify({
          ok: true,
          items: [
            {
              type: "message",
              channel: "C123",
              date_create: Math.floor(Date.now() / 1000) - 60,
              message: { ts: "1714391940.000200", text: "recent item", user: "U123" },
            },
            {
              type: "message",
              channel: "C999",
              date_create: Math.floor(Date.now() / 1000) - (72 * 3600),
              message: { ts: "1714132800.000200", text: "old item", user: "U999" },
            },
          ],
        }));
      }
      if (url.pathname.endsWith("/chat.getPermalink")) {
        return new Response(JSON.stringify({
          ok: true,
          permalink: "https://example.slack.com/archives/C123/p1714391940000200",
        }));
      }
      throw new Error(`Unexpected Slack API call: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const slackTool = createSlackTools().find((tool) => tool.name === "slack");
    const result = await slackTool?.handler({
      action: "saved_items",
      since_hours: 48,
    });

    expect(result).toMatchObject({
      count: 1,
      items: [
        {
          channel_id: "C123",
          text: "recent item",
          user: "U123",
          ts: "1714391940.000200",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes stars with the Slack user token", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/stars.remove");
      expect(url.searchParams.get("channel")).toBe("C123");
      expect(url.searchParams.get("timestamp")).toBe("1714391940.000200");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer xoxp-user" });
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const slackTool = createSlackTools().find((tool) => tool.name === "slack");
    const result = await slackTool?.handler({
      action: "remove_star",
      channel_id: "C123",
      timestamp: "1714391940.000200",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
