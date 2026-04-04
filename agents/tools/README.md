# Agent Tool Docs

Standalone tool docs loaded into worker prompts from `tool_contract_ids`.

See [`docs/guides/agents-structure.md`](../../docs/guides/agents-structure.md) for placement rules, and [`docs/guides/adding-tools.md`](../../docs/guides/adding-tools.md) for the runtime wiring checklist.

| Doc | Tool IDs | Workers | Paired skills |
| --- | --- | --- | --- |
| `atlas-sql.md` | `atlas_sql` | `nutrition-logger`, `recipe-librarian` | |
| `fatsecret.md` | `fatsecret_api` | `nutrition-logger`, `recipe-librarian` | |
| `health.md` | `health_query` | `health-analyst` | `health-baselines.md` |
| `workout-sql.md` | `workout_sql` | `workout-recorder` | |
| `recipe.md` | `recipe_list`, `recipe_read`, `recipe_write` | `nutrition-logger`, `recipe-librarian` | `recipe-format.md` |
| `gog-email.md` | `gog_email` | `personal-assistant` | |
| `gog-calendar.md` | `gog_calendar` | `personal-assistant` | |
| `gog-docs.md` | `gog_docs` | `personal-assistant` | |
| `obsidian.md` | `obsidian` | `personal-assistant` | `obsidian-note-conventions.md` |
| `health-morning.md` | `health_morning` | `personal-assistant` | `health-baselines.md` |
| `lunch-money.md` | `lunch_money` | `personal-assistant` | |
| `exa.md` | `exa_search`, `exa_answer` | `research-assistant` | |
| `printing.md` | `printer_command`, `openscad_render`, `prusa_slice` | `research-assistant` | `printing-profile-selection.md` |
| `travel.md` | `location_read`, `find_diesel` | `research-assistant` | `travel-routing.md` |
| `walmart.md` | `walmart` | `research-assistant` | |
| `browser.md` | `browser` | `personal-assistant`, `research-assistant` | |
| `agent-docs.md` | `agent_docs` | `personal-assistant` | |
| `latitude-remote.md` | `latitude_run` | `personal-assistant` | |
| `linear.md` | `linear` | `personal-assistant` | |
| `discord-manage.md` | `discord_manage` | `dev-assistant` | |
| `tango-dev.md` | `tango_shell`, `tango_file` | `dev-assistant` | |

Notes:
- Tool docs describe capabilities, params, return shapes, and examples.
- Reusable workflow guidance belongs in `agents/skills/*.md`, not in tool docs.
- Worker `soul.md` files should carry behavior, constraints, and output expectations only.
- Assistant domain knowledge lives in `agents/assistants/<agent>/knowledge.md`, not here.
