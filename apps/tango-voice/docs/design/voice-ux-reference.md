# Voice UX Reference

**Status:** Current as of 2026-03-08 (Phases 1-4 of Voice UX v2)
**Design doc:** `docs/plans/voice-ux-v2-the-office.md`
**Supersedes:** `inbox-mission-control.md` (modes evolving toward table model)

## How It Works

The voice system uses **gated mode** with **indicate endpointing**:

- **Mic is always hot** but nothing activates until a wake word is spoken
- **Wake words** are agent names (Watson, Malibu, Sierra) or "Tango" for system commands
- **Speech boundaries** are marked by explicit close words, not silence detection
- The user can pause, think, and resume speaking without the system cutting them off

## Addressing Agents

Say an agent's name to start talking to them. The system auto-switches to that agent's channel context.

```
"Malibu, how's my recovery looking? Go ahead."
"Watson, what time is the standup? Go ahead."
"Sierra, find me a good standing desk. Thanks."
```

### Agent Roster

| Agent | Wake Words | Domain |
|-------|-----------|--------|
| **Watson** | Watson | Personal assistant — planning, calendar, email, finance, general Q&A |
| **Malibu** | Malibu, Coach Malibu | Wellness — health, workouts, nutrition, cooking, recipes |
| **Sierra** | Sierra | Research & procurement — deep research, shopping, product comparison |
| **Tango** | Watson (system wake) | System-level commands (pause, resume, status, settings) |

Watson is also the default — unaddressed speech goes to Watson.

## Two Close Types

Every utterance ends with a close word that tells the system what to do next.

Wake-led quick requests are the one exception: a one-shot utterance like "Malibu, what's my protein intake today?" dispatches to the background by default unless you explicitly end with a conversational close.

### Conversational Close — "I'll wait for your answer"

| Word | Example |
|------|---------|
| **go ahead** | "Watson, what's the plan today? Go ahead." |
| **I'm done** | "Malibu, how's my recovery looking? I'm done." |
| **I'm finished** | "Sierra, compare these two options. I'm finished." |

After a conversational close:
1. Processing hum plays while agent thinks
2. Agent's response plays back via TTS
3. You stay in conversation — can follow up or dismiss

### Dismiss Close — "Go work on it, I'm heading back"

| Word | Example |
|------|---------|
| **thanks** | "Malibu, log a protein shake. Thanks." |
| **thanks [name]** | "Watson, send that email. Thanks Watson." |
| **Tango Tango** | "Sierra, order the usual from Chipotle. Tango Tango." |
| **that's all** | "Malibu, log eggs for breakfast. That's all." |

After a dismiss close:
1. Acknowledged earcon plays (quick confirmation tone)
2. Agent dispatches in background
3. You return to idle — ready to address another agent or hear notifications
4. When the response arrives, you'll hear a notification

### Wake Word Requirement

- **Conversational closes** work best as multi-word phrases: bare "go ahead" ✓ / bare "I'm done" ✓ / bare "over" ✗
- **Legacy compatibility:** wake-prefixed "Watson, over" still works, but `go ahead` is the preferred phrase now
- **Dismiss closes** work without wake word: bare "thanks" ✓ / "thanks Malibu" ✓ / "Tango Tango" ✓

## System Commands

System commands use the system wake word (Watson/Tango) followed by a command.

### Pause / Resume

```
"Watson, pause."          → Stops playback, mutes notifications
"Watson, resume."         → Replays last response, unmutes notifications
```

Also accepts: "continue", "carry on", "go on", "unpause", "pick up where you left off"

During pause:
- TTS playback stops immediately
- All notifications are deferred (5-second retry loop)
- Agents continue working in the background
- Paused/resumed earcons confirm the state change

### Status

```
"Watson, what's up?"      → Reports ready responses, pending items, queued notifications
```

Also accepts: "any updates", "anything new", "status update", "what do you have for me"

Works without wake word in background mode or during grace periods.

### Other Commands

| Command | What it does |
|---------|-------------|
| **replay** / **say that again** | Replays the last spoken response |
| **hear full message** | Reads the full (unsummarized) version of the last response |
| **settings** | Reports current voice settings |
| **earcon tour** | Plays all earcon sounds with labels |

## Earcons (Sound Cues)

| Sound | When | Character |
|-------|------|-----------|
| **Listening** | Agent name recognized | Single high A5 tap — bright, quick |
| **Acknowledged** | Dismiss close accepted | Ascending G4→C5 — warm "got it" |
| **Ready** | Response about to play | Ascending E5→G5→C6 — bright fanfare |
| **Error** | Something went wrong | Descending E4→C4 — low, gentle |
| **Timeout warning** | Indicate capture timing out | Tick-tock pattern — clock-like |
| **Cancelled** | Flow cancelled | Descending G4→E4→C4 — winding down |
| **Busy** | Heard you but occupied | Low C4 hum — brief |
| **Gate closed** | Speech without wake word | Single A4 tap — soft click |
| **Paused** | Tango pause confirmed | Descending C5→G4 — setting down |
| **Resumed** | Tango resume confirmed | Ascending G4→C5 — picking up |

## Modes (Legacy)

Three dispatch modes still exist for backward compatibility. With indicate closes, the close type overrides the mode:

| Mode | Without indicate close | With indicate close |
|------|----------------------|-------------------|
| **Wait** | Dispatch + wait for response inline | Close type decides |
| **Queue** | Dispatch + "Queued to X" confirmation | Close type decides |
| **Ask** | Dispatch + "Inbox, or wait?" prompt | Close type decides |

The close type is the intended interaction pattern going forward. Modes will be deprecated as the table model matures.

## Example Flows

### Quick logging (dismiss)

```
You: "Malibu, log a protein shake for lunch. Thanks."
     [listening earcon]
     ...indicate capture...
     [acknowledged earcon]  ← dispatched, back to idle
     [ready earcon]

     ... later ...
     "Malibu has a response."  ← notification
```

### Conversation (conversational close)

```
You: "Malibu, how's my recovery looking? Go ahead."
     [listening earcon]
     ...indicate capture...
     [processing hum...]
Malibu: "HRV is up 12%, sleep score 84. Looking good."
     [ready earcon]

You: "Nice. What about my workout volume this week? Go ahead."
     [listening earcon]
     ...
```

### Pause mid-response

```
Watson: "For the morning plan, I'd suggest starting with—"
You: "Watson, pause."
     [paused earcon]
     ... phone rings, 10 minutes pass ...
You: "Watson, resume."
     [resumed earcon]
Watson: "For the morning plan, I'd suggest starting with..."
     [ready earcon]
```

### Table status check

```
You: "What's up?"
Watson: "Malibu has a response ready. Sierra is still working.
         2 notifications queued. Nothing urgent."
```

## Architecture Notes

- **Channel auto-switch**: When an agent is addressed by name, the pipeline silently switches to that agent's default Discord channel. This ensures the correct session context, history, and system prompt.
- **Indicate capture**: Speech segments accumulate until a close word is detected. The close word itself is not included in the dispatched transcript.
- **Fire-and-forget dispatch**: Both dismiss and queue-mode dispatches use `dispatchToLLMFireAndForget` with queue tracking. The response poller detects when responses are ready and delivers notifications.
- **Notification deferral**: Notifications are suppressed during active conversation (indicate capture, pending wait callback, playback, pause). They deliver when the user returns to idle.
