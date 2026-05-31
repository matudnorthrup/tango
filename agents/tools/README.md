# Agent Tool Docs

Standalone tool docs for callable surfaces. V2 agents receive tools through MCP
server allowlists; add concise operating guidance to loaded agent prompts or
focused skills when a tool needs judgment beyond its schema.

See [`docs/guides/agents-structure.md`](../../docs/guides/agents-structure.md) for placement rules, and [`docs/guides/adding-tools.md`](../../docs/guides/adding-tools.md) for the runtime wiring checklist.

| Doc | Tool IDs | Primary agents/domains | Paired skills |
| --- | --- | --- | --- |
| `atlas-sql.md` | `atlas_sql` | Malibu / nutrition | |
| `fatsecret.md` | `fatsecret_api` | Malibu / nutrition | |
| `nutrition-log-items.md` | `nutrition_log_items` | Malibu / nutrition | `food-logging.md` |
| `health.md` | `health_query` | Malibu / health | `health-baselines.md` |
| `workout-sql.md` | `workout_sql` | Malibu / workouts | |
| `recipe.md` | `recipe_list`, `recipe_read`, `recipe_write` | Malibu / recipes | `recipe-format.md` |
| `gog-email.md` | `gog_email` | Watson / email | |
| `gog-calendar.md` | `gog_calendar` | Watson / calendar | |
| `gog-docs.md` | `gog_docs` | Watson / docs | |
| `gog-docs-update-tab.md` | `gog_docs_update_tab` | Watson / docs | |
| `obsidian.md` | `obsidian` | Watson / notes | `obsidian-note-conventions.md` |
| `health-morning.md` | `health_morning` | Watson / health brief | `health-baselines.md` |
| `lunch-money.md` | `lunch_money` | Foxtrot / finance | |
| `exa.md` | `exa_search`, `exa_answer` | Sierra / research | |
| `printing.md` | `printer_command`, `openscad_render`, `prusa_slice` | Sierra / fabrication | `printing-profile-selection.md` |
| `travel.md` | `location_read`, `find_diesel` | Sierra / travel | `travel-routing.md` |
| `walmart.md` | `walmart` | Sierra / shopping | |
| `browser.md` | `browser` | Watson / Sierra browser flows | |
| `agent-docs.md` | `agent_docs` | Agent self-update | |
| `latitude-remote.md` | `latitude_run` | Watson / work systems | |
| `linear.md` | `linear` | Victor / project tracking | |
| `discord-manage.md` | `discord_manage` | Dev agents | |
| `tango-dev.md` | `tango_shell`, `tango_file` | Dev agents | |

Notes:
- Tool docs describe capabilities, params, return shapes, and examples.
- Reusable workflow guidance belongs in `agents/skills/*.md`, not in tool docs.
- Assistant domain knowledge lives in `agents/assistants/<agent>/knowledge.md`, not here.
