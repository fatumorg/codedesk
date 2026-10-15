# Codedesk

A desktop workspace for Claude Code (Electron, vanilla JS UI, Nix flake).

## Rules

- Always use the Superpowers skills (`superpowers:*`) for process: brainstorming, plans, debugging, verification.
- Always use Tasteskill (`design-taste-frontend`) for any UI or design work.
- Always use Ponytail (`ponytail:ponytail`): the simplest, shortest solution that works.
- Always use Graphify (`/graphify`) to map and query the codebase before larger changes.
- Never write code comments. Delete any comment you find in files you touch.
- Git: if the project is a git repository, commit and push only as the user, using their configured git identity. Never author or co-author as Claude: no `Co-Authored-By: Claude` trailers, no "Generated with Claude Code" lines, no Claude identity in commits or PRs.
- Spawn subagents only when they are truly necessary. Each subagent runs in its own context window and adds to usage. Do the work inline whenever you can.
