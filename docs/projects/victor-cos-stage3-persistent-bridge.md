# Victor-as-CoS Stage 3: Persistent Session Discord Bridge

**Status:** Discovery
**Linear Project:** Victor as Chief-of-Staff (3f6ae9dc)
**Started:** 2026-04-22

## Problem

Victor currently runs as ephemeral v2 turns — each Discord message spawns a fresh Claude Code adapter process. This means Victor cannot maintain state between messages (no memory of ongoing monitoring, no ability to proactively push updates, no long-running coordination tasks). The VICTOR-COS tmux session concept exists in his soul.md but there's no infrastructure to bridge Discord messages to/from it.

## Discovery: Routing Chain Analysis

### Text Message Path

```
Discord messageCreate
  → isChannelAllowed() filter
  → bot/dedup filters
  → enqueueChannelWork(channelKey, handleMessage)
    → sessionManager.route(channelKey) → {sessionId, agentId}
    → resolveContextualTargetAgent() → picks Victor
    → evaluateAccess() → access control check
    → v2EnabledAgents.has("victor") → TRUE (victor.yaml has runtime.mode: persistent)
    → routeV2MessageIfEnabled()
      → tangoRouter.routeMessage({message, channelId, threadId, agentId: "victor"})
        → lifecycleManager.sendMessage(conversationKey, agentConfig, message)
          → Spawns ephemeral Claude Code process via ClaudeCodeAdapter
          → Returns RuntimeResponse with text
    → sendPresentedReply(channel, response.text, targetAgent)
      → replyPresenter.sendChunked() with webhook avatar
    → writeMessage() to session DB (inbound + outbound)
    → writeModelRun() for telemetry
```

### Voice Message Path

```
apps/tango-voice STT → HTTP bridge POST /voice/turn
  → executeVoiceTurn(turnInput)
    → agentRegistry.get(agentId) → Victor
    → voice turn receipt dedup
    → writeMessage(inbound)
    → dispatchVoiceTurnByRuntime()
      → v2AgentConfig exists → voiceTangoRouter.routeMessage()
        → Same ClaudeCodeAdapter ephemeral spawn
        → Returns VoiceTurnResult with responseText
    → writeMessage(outbound)
    → syncVoiceAgentResponseToDiscord()
```

### Key Intercept Point

The interception should happen at the **`routeMessage`** level — specifically, before `tangoRouter.routeMessage()` / `voiceTangoRouter.routeMessage()` for Victor. This is the narrowest intercept that captures both text and voice while preserving all the upstream routing (session lookup, access control, message recording) and downstream presentation (`sendPresentedReply`, session DB writes).

## Design: Persistent Session Bridge

### Architecture

```
                    ┌─────────────────┐
                    │  Discord Bot    │
                    │  (main.ts)      │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ handleMessage() │  (or executeVoiceTurn)
                    │  route, access  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Victor bridge   │  NEW: check persistent session
                    │ intercept       │
                    └───┬─────────┬───┘
                        │         │
              ┌─────────▼──┐  ┌──▼─────────────┐
              │ Persistent  │  │ Ephemeral v2    │
              │ tmux bridge │  │ (current path)  │
              └─────────┬──┘  └─────────────────┘
                        │
              ┌─────────▼──────────┐
              │ VICTOR-COS tmux    │
              │ inbox file +       │
              │ response file      │
              └────────────────────┘
```

### Component 1: Session Detection

```typescript
// New function in main.ts or a new victor-bridge.ts module
function isVictorPersistentSessionActive(): boolean {
  // Option A: Check tmux session exists
  try {
    execSync('tmux has-session -t VICTOR-COS 2>/dev/null');
    return true;
  } catch {
    return false;
  }
  // Could also check a state file at /tmp/victor-cos-active
}
```

**Decision:** Use tmux session check. It's authoritative — if the session doesn't exist, there's nothing to bridge to. Cache the result for 30s to avoid shell spawns on every message.

### Component 2: Inbound Bridge (Discord → tmux)

**Chosen approach: File inbox with watcher**

The tmux `send-keys` approach is fragile — Victor might be mid-task and the input would interleave. Instead:

1. Bot writes a JSON message file to `/tmp/victor-cos-inbox/{timestamp}-{uuid}.json`
2. Victor's persistent session watches this directory (via `fs.watch` or polling)
3. Each message file contains:
```json
{
  "id": "uuid",
  "timestamp": "ISO",
  "source": "discord-text|discord-voice",
  "user": { "id": "...", "username": "..." },
  "channel": { "id": "...", "threadId": "..." },
  "content": "message text",
  "sessionId": "...",
  "agentId": "victor",
  "replyTo": "/tmp/victor-cos-outbox/{id}.json"
}
```
4. Victor reads the file, processes it, writes response to the `replyTo` path
5. Bot watches the outbox directory and picks up responses

**Busy handling:** If Victor is processing a previous message, inbox files queue naturally. Victor processes them FIFO by timestamp. The bot shows typing indicator while waiting for the response file.

### Component 3: Outbound Bridge (tmux → Discord)

**Chosen approach: Response file + presentation layer**

Victor writes response to `/tmp/victor-cos-outbox/{request-id}.json`:
```json
{
  "requestId": "uuid",
  "text": "response text",
  "timestamp": "ISO"
}
```

The bot's watcher picks this up and calls `sendPresentedReply(channel, text, victorAgent)` — preserving webhook avatars, chunking, and thread routing. The bot also writes the outbound message to the session DB.

**Why not direct `discord_manage send_message`?** That bypasses the presentation layer (no avatar, no chunking, no session DB write). Victor can still use `discord_manage` for proactive messages (status updates, alerts), but responses to user messages should go through the bridge for consistency.

### Component 4: Voice Bridge

Same file-based approach. The `executeVoiceTurn` function:
1. Detects persistent session active
2. Writes inbox file with `source: "discord-voice"`
3. Waits for response file (with timeout matching `VOICE_V2_ROUTER_TIMEOUT_MS`)
4. Returns `VoiceTurnResult` with the response text → goes through TTS

### Component 5: Session Lifecycle

- **Start:** Manual — user runs a script or Victor auto-spawns on first interaction
- **Stop:** Manual or idle timeout (configurable, default 24h per victor.yaml)
- **Fallback:** If `isVictorPersistentSessionActive()` returns false, fall through to normal ephemeral v2 path. Zero behavior change for other agents.

### Implementation Plan

1. **New module `packages/discord/src/victor-bridge.ts`:**
   - `isVictorPersistentSessionActive()` — cached tmux check
   - `sendToVictorInbox(message)` — write inbox file
   - `waitForVictorResponse(requestId, timeoutMs)` — watch outbox, return response
   - `startOutboxWatcher()` — fs.watch on outbox dir for proactive messages

2. **Modify `handleMessage()` in main.ts (line ~7361):**
   - Before `routeV2MessageIfEnabled()`, check if agent is Victor AND persistent session is active
   - If yes, call `sendToVictorInbox()` + `waitForVictorResponse()`
   - Use the response text with existing `sendPresentedReply()` + `writeMessage()`

3. **Modify `executeVoiceTurn()` in main.ts (line ~3779):**
   - Same intercept before `dispatchVoiceTurnByRuntime()`
   - Return `VoiceTurnResult` from bridge response

4. **Victor-side inbox processor:**
   - Script/prompt that tells Victor's persistent session to watch `/tmp/victor-cos-inbox/`
   - On new file: read, process, write response to outbox
   - This runs inside the VICTOR-COS Claude Code session

### Files Changed

- `packages/discord/src/victor-bridge.ts` — NEW (bridge module)
- `packages/discord/src/main.ts` — intercepts in handleMessage + executeVoiceTurn
- `scripts/victor-cos-start.sh` — NEW (start persistent session with inbox watcher instructions)

### Risks

1. **File I/O latency** — should be negligible on local filesystem
2. **Race conditions** — use atomic rename (write to .tmp, rename to .json) for both inbox and outbox
3. **Stale responses** — timeout + cleanup of old files
4. **Victor context window** — persistent session accumulates context; needs compaction strategy (existing `context_reset_threshold: 0.80` in config)

### Backward Compatibility

- No changes for Watson, Malibu, Sierra, Juliet — the intercept is gated on `agentId === "victor"` AND session exists
- If VICTOR-COS is not running, Victor works exactly as today (ephemeral v2)
- The bridge module is self-contained — if it breaks, remove the two intercept points and everything reverts

## Key Files

- `packages/discord/src/main.ts` — message handler, voice turn handler
- `packages/discord/src/tango-router.ts` — TangoRouter (v2 routing)
- `packages/discord/src/v2-runtime.ts` — v2 feature flag routing
- `packages/discord/src/voice-turn-runtime-routing.ts` — voice v2 dispatch
- `packages/core/src/claude-code-adapter.ts` — ephemeral Claude Code process
- `config/v2/agents/victor.yaml` — Victor's v2 config
- `agents/assistants/victor/soul.md` — Victor's personality/instructions
