# Tango Post-Reboot Startup Checklist

The current operator-facing checklist lives in the main Obsidian vault:

```text
/Users/devinnorthrup/Documents/main/References/Tango Post-Outage Startup Checklist.md
```

Use that note as the source of truth for post-reboot, power-loss, app-crash, or
partial-outage recovery. It is linked from `Life Operating System` and `Human AI
Workflow`, and includes the current tailnet site checks, Kilo Ledger, Tango
Workout, OwnTracks, voice, schedules, and the NOFO self-hosted GitHub Actions
runner.

This repo file exists only as a discoverable pointer for agents that start from
the codebase. Do not duplicate the checklist here; update the Obsidian note
instead to avoid drift.

Emergency bootstrap if the vault is unavailable:

```bash
cd /Users/devinnorthrup/GitHub/tango
scripts/startup.sh
```

After bootstrap, still verify the Obsidian checklist when the vault is available.
