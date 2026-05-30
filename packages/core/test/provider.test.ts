import { describe, expect, it } from "vitest";
import {
  buildClaudeCliArgs,
  buildCodexExecArgs,
  parseClaudePrintJson,
  parseCodexExecJson
} from "../src/provider.js";

describe("parseClaudePrintJson", () => {
  it("parses a claude JSON result line", () => {
    const parsed = parseClaudePrintJson(
      '{"type":"result","is_error":false,"result":"hello world","session_id":"abc-123"}\n'
    );

    expect(parsed.text).toBe("hello world");
    expect(parsed.providerSessionId).toBe("abc-123");
  });

  it("uses the last JSON line when output has prelude noise", () => {
    const parsed = parseClaudePrintJson(
      "Warning: something\n" +
        '{"type":"result","is_error":false,"result":"ignored","session_id":"one"}\n' +
        '{"type":"result","is_error":false,"result":"final answer","session_id":"two"}\n'
    );

    expect(parsed.text).toBe("final answer");
    expect(parsed.providerSessionId).toBe("two");
  });

  it("extracts normalized tool calls from Claude stream-json assistant events", () => {
    const parsed = parseClaudePrintJson(
      '{"type":"system","subtype":"init","session_id":"sess-1"}\n' +
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"ToolSearch","input":{"query":"select:mcp__example__read_status"}}]}}\n' +
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__example__read_status","input":{"scope":"planner"}}]}}\n' +
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Status read."}]}}\n' +
        '{"type":"result","is_error":false,"result":"Status read.","session_id":"sess-1"}\n'
    );

    expect(parsed.text).toBe("Status read.");
    expect(parsed.providerSessionId).toBe("sess-1");
    expect(parsed.toolCalls).toEqual([
      {
        name: "ToolSearch",
        input: {
          query: "select:mcp__example__read_status",
        },
        output: undefined,
        serverName: undefined,
        toolName: "ToolSearch",
      },
      {
        name: "mcp__example__read_status",
        input: {
          scope: "planner",
        },
        output: undefined,
        serverName: undefined,
        toolName: "mcp__example__read_status",
      },
    ]);
  });

  it("extracts normalized tool calls from Claude result payloads", () => {
    const parsed = parseClaudePrintJson(
      '{"type":"result","is_error":false,"result":"done","session_id":"abc-123","tool_uses":[{"name":"mcp__example__read_status","input":{"scope":"planner"}}]}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__example__read_status",
        input: {
          scope: "planner",
        },
        output: undefined,
        serverName: undefined,
        toolName: "mcp__example__read_status",
      },
    ]);
  });

  it("throws when no valid result JSON is present", () => {
    expect(() => parseClaudePrintJson("not-json\n")).toThrow(
      "Failed to parse Claude CLI JSON output"
    );
  });
});

describe("buildClaudeCliArgs", () => {
  it("disables tools by default", () => {
    const args = buildClaudeCliArgs(
      {
        prompt: "hello"
      },
      { defaultModel: "claude-sonnet-4-6" }
    );

    expect(args).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "",
      "--model",
      "claude-sonnet-4-6",
      "hello"
    ]);
  });

  it("enables default toolset when requested", () => {
    const args = buildClaudeCliArgs(
      {
        prompt: "weather now",
        tools: { mode: "default" }
      },
      { defaultModel: "claude-sonnet-4-6" }
    );

    expect(args).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "default",
      "--model",
      "claude-sonnet-4-6",
      "weather now"
    ]);
  });

  it("supports allowlisted tools", () => {
    const args = buildClaudeCliArgs(
      {
        prompt: "check weather",
        tools: {
          mode: "allowlist",
          allowlist: ["Bash(curl:*)", "WebSearch", "WebSearch"],
        },
        providerSessionId: "sess-1",
        systemPrompt: "You are Watson."
      },
      { defaultModel: "claude-sonnet-4-6", mcpConfigPath: "/tmp/dispatch.json" }
    );

    expect(args).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "default",
      "--allowedTools",
      "Bash(curl:*)",
      "WebSearch",
      "--mcp-config",
      "/tmp/dispatch.json",
      "--resume",
      "sess-1",
      "--system-prompt",
      "You are Watson.",
      "--model",
      "claude-sonnet-4-6",
      "check weather"
    ]);
  });

  it("lets request model and reasoning effort override provider defaults", () => {
    const args = buildClaudeCliArgs(
      {
        prompt: "think it through",
        model: "claude-opus-4-8",
        reasoningEffort: "xhigh",
      },
      { defaultModel: "claude-sonnet-4-6", defaultReasoningEffort: "medium" }
    );

    expect(args).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      "",
      "--model",
      "claude-opus-4-8",
      "--effort",
      "max",
      "think it through"
    ]);
  });

  it("throws on empty allowlist mode", () => {
    expect(() =>
      buildClaudeCliArgs(
        {
          prompt: "test",
          tools: { mode: "allowlist", allowlist: [] }
        },
        { defaultModel: "claude-sonnet-4-6" }
      )
    ).toThrow(/requires at least one tool/u);
  });
});

describe("parseCodexExecJson", () => {
  it("parses codex jsonl output with thread + final agent message", () => {
    const parsed = parseCodexExecJson(
      '{"type":"thread.started","thread_id":"thread-123"}\n' +
        '{"type":"turn.started"}\n' +
        '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":7,"output_tokens":3}}\n'
    );

    expect(parsed.providerSessionId).toBe("thread-123");
    expect(parsed.text).toBe("hello from codex");
    expect(parsed.metadata?.usage).toEqual({
      inputTokens: 11,
      cacheReadInputTokens: 7,
      outputTokens: 3
    });
  });

  it("extracts Codex MCP tool calls from completed mcp_tool_call events", () => {
    const parsed = parseCodexExecJson(
      '{"type":"thread.started","thread_id":"thread-123"}\n' +
        '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"wellness","tool":"health_query","arguments":{"command":"recovery","date":"today"},"result":null,"error":null,"status":"in_progress"}}\n' +
        '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"wellness","tool":"health_query","arguments":{"command":"recovery","date":"today"},"result":{"ok":true},"error":null,"status":"completed"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":7,"output_tokens":3}}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__wellness__health_query",
        toolName: "health_query",
        serverName: "wellness",
        input: {
          command: "recovery",
          date: "today",
        },
        output: { ok: true },
      },
    ]);
  });

  it("extracts failed Codex MCP tool calls with error payloads", () => {
    const parsed = parseCodexExecJson(
      '{"type":"thread.started","thread_id":"thread-123"}\n' +
        '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"wellness","tool":"health_query","arguments":{"command":"recovery","date":"today"},"result":null,"error":{"message":"user cancelled MCP tool call"},"status":"failed"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":7,"output_tokens":3}}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__wellness__health_query",
        toolName: "health_query",
        serverName: "wellness",
        input: {
          command: "recovery",
          date: "today",
        },
        output: { message: "user cancelled MCP tool call" },
      },
    ]);
  });

  it("extracts completed MCP tool calls into normalized toolCalls", () => {
    const parsed = parseCodexExecJson(
      '{"type":"thread.started","thread_id":"thread-123"}\n' +
        '{"type":"turn.started"}\n' +
        '{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"example","tool":"read_status","arguments":{"scope":"planner"},"result":null,"error":null,"status":"in_progress"}}\n' +
        '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"example","tool":"read_status","arguments":{"scope":"planner"},"result":{"content":[{"type":"text","text":"ok"}]},"error":null,"status":"completed"}}\n' +
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n' +
        '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":3}}\n'
    );

    expect(parsed.toolCalls).toEqual([
      {
        name: "mcp__example__read_status",
        input: {
          scope: "planner",
        },
        output: {
          content: [
            {
              type: "text",
              text: "ok",
            },
          ],
        },
        serverName: "example",
        toolName: "read_status",
      },
    ]);
  });

  it("throws when no agent message is present", () => {
    expect(() =>
      parseCodexExecJson(
        '{"type":"thread.started","thread_id":"thread-123"}\n' +
          '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":3}}\n'
      )
    ).toThrow("Codex CLI returned an empty response");
  });
});

describe("buildCodexExecArgs", () => {
  it("uses codex exec with safe defaults and no search when tools are off", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "hello",
        tools: { mode: "off" }
      },
      {
        defaultModel: "gpt-5-codex",
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5-codex",
      "hello"
    ]);
  });

  it("enables search for default tool mode", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "weather in london",
        tools: { mode: "default" }
      },
      {
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "--search",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "weather in london"
    ]);
  });

  it("uses resume path and embeds system prompt", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "Give me a one line summary",
        providerSessionId: "thread-abc",
        systemPrompt: "You are Watson."
      },
      {
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "thread-abc",
      "System instructions:\nYou are Watson.\n\nUser request:\nGive me a one line summary"
    ]);
  });

  it("injects MCP server config overrides for codex", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "use configured mcp",
        tools: {
          mode: "allowlist",
          allowlist: ["WebSearch", "mcp__example__read_status"],
          mcpServers: {
            example: {
              command: "/usr/bin/env",
              args: ["node", "/tmp/mcp-example-server.js"],
              env: {
                EXAMPLE_SCOPE: "planner",
              },
            },
          },
        },
      },
      {
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "--search",
      "-c",
      "mcp_servers.example.command=\"/usr/bin/env\"",
      "-c",
      "mcp_servers.example.args=[\"node\",\"/tmp/mcp-example-server.js\"]",
      "-c",
      "mcp_servers.example.env={EXAMPLE_SCOPE=\"planner\"}",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "use configured mcp"
    ]);
  });

  it("uses request model overrides and explicit reasoning effort for codex", () => {
    const args = buildCodexExecArgs(
      {
        prompt: "summarize this",
        model: "gpt-5.4-mini",
        reasoningEffort: "max",
        tools: { mode: "off" },
      },
      {
        defaultModel: "gpt-5.4",
        defaultReasoningEffort: "medium",
        sandbox: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
      }
    );

    expect(args).toEqual([
      "-a",
      "never",
      "--sandbox",
      "read-only",
      "-c",
      "model_reasoning_effort=\"xhigh\"",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4-mini",
      "summarize this"
    ]);
  });
});
