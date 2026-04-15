# Agent Skills

Shared workflow guidance for Tango agents.

See [`docs/guides/agents-structure.md`](../../docs/guides/agents-structure.md) for placement rules and the skill-creation checklist.

Purpose:
- capture reusable "how to do this well" knowledge
- avoid overloading assistant `knowledge.md` files with cross-domain guidance
- keep worker `soul.md` files focused on behavior and output rules

Prompt assembly loads these docs into worker prompts from `config/defaults/workers/*.yaml` via `skill_doc_ids`.

| Doc | Skill ID | Workers | Purpose |
| --- | --- | --- | --- |
| `amazon-orders.md` | `amazon_orders` | `personal-assistant` | Browser navigation for Amazon order lookup |
| `chipotle-ordering.md` | `chipotle_ordering` | `research-assistant` | Browser navigation for Chipotle ordering (favorites, location selection) |
| `daily-planning.md` | `daily_planning` | `personal-assistant` | Morning planning, evening check-in, weekly planning workflows |
| `open-meteo-weather.md` | `open_meteo_weather` | `research-assistant` | Open-Meteo free weather API (current + forecast) |
| `osrm-routing.md` | `osrm_routing` | `research-assistant` | OSRM free driving distance/duration API — never estimate distances |
| `email-review.md` | `email_review` | `personal-assistant` | Email triage phases, drafting voice, reply conventions |
| `evening-checkin.md` | `evening_checkin` | `nutrition-logger` | Pre-dinner calorie budget (TDEE + FatSecret intake) |
| `health-baselines.md` | `health_baselines` | `health-analyst`, `personal-assistant` | Baseline comparisons for health summaries |
| `obsidian-note-conventions.md` | `obsidian_note_conventions` | `personal-assistant` | Vault note structure and task conventions |
| `printing-profile-selection.md` | `printing_profile_selection` | `research-assistant` | Print/material selection and reporting rules |
| `receipt-logging.md` | `receipt_logging` | `personal-assistant` | General-purpose Obsidian receipt file creation |
| `sinking-fund-reconciliation.md` | `sinking_fund_reconciliation` | `personal-assistant` | Lunch Money and Obsidian workflow for SB-backed expense reconciliation |
| `recipe-format.md` | `recipe_format` | `nutrition-logger`, `recipe-librarian` | Recipe markdown structure and write rules |
| `transaction-categorization.md` | `transaction_categorization` | `personal-assistant` | Lunch Money categorization, rules, splits |
| `travel-routing.md` | `travel_routing` | `research-assistant` | Current-location and diesel-stop heuristics |
| `walmart-orders.md` | `walmart_orders` | `personal-assistant` | Browser navigation for Walmart order lookup |

Rules:
- Skills capture reusable workflows and judgment, not tool schemas.
- Keep them short enough to load directly into worker prompts.
- Put assistant-specific facts in `agents/assistants/<id>/knowledge.md`, not here.
