# Docs

This directory contains durable project knowledge. Active project tracking,
status updates, validation evidence, and approval gates belong in Linear, not in
repo markdown.

Current structure:

- `guides/`: stable operator, contributor, and agent process documentation
- `specs/`: implementation-facing product specs
- `architecture/`: architecture decisions and current architecture references
- `projects/`: legacy project writeups and retros; do not add mutable project
  status here when Linear can hold the source of truth
- root-level docs: longer-lived design references that have not yet been moved
  into `architecture/`

Retention policy:

- Keep architecture decisions, retros/postmortems, operator guides, specs, and
  safe prompt/runtime asset docs in the repo.
- Move active project plans, mutable status updates, validation evidence, open
  questions, approval gates, and work breakdowns into Linear.
- Move private user context, raw personal analysis, machine-local artifacts, and
  profile-specific prompt/config overlays outside the repo.

Start here:

- Project overview: [`about.md`](./about.md)
- Setup guide: [`guides/setup.md`](./guides/setup.md)
- Agent operating model: [`guides/agent-operating-model.md`](./guides/agent-operating-model.md)
- Public launch guide: [`guides/public-launch.md`](./guides/public-launch.md)
- Profile/config model: [`guides/profile-model.md`](./guides/profile-model.md)
- Agent structure: [`guides/agents-structure.md`](./guides/agents-structure.md)
- Tool integration guide: [`guides/adding-tools.md`](./guides/adding-tools.md)
