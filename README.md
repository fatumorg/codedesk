# Codedesk

Codedesk is a desktop workspace for Claude Code on Linux (including NixOS), macOS and Windows. It drives your installed
`claude` CLI through the official Claude Agent SDK, so your login, settings, CLAUDE.md, hooks, skills,
plugins, MCP servers and custom slash commands all carry over.

## Install

**NixOS / Nix:** `nix run .`, or add `packages.${system}.default` from this flake to your system
packages. That puts a "Codedesk" entry in your app launcher.

**Other platforms:** `npm install`, then `npm start` to run, or `npm run dist` to build an
AppImage/deb/rpm, dmg, or Windows installer into `dist/`.

You need Claude Code installed and signed in (`claude auth login`), or use the app's Sign in button.
`CLAUDE_PATH` overrides which `claude` binary is used.

## What's in it

- **Tabs:** several conversations at once, each with its own project, model and permission mode.
- **Conversations:** browse by project, search, rename, fork, export to Markdown, delete, resume.
- **Composer:** `/` commands (built-in, skills, plugins, custom), `@` files/folders/agents,
  `!cmd` runs a shell command and hands Claude the output, `#note` saves to CLAUDE.md,
  paste or drop images/PDFs, ↑/↓ prompt history, Tab takes the suggested next prompt,
  messages queue while Claude works.
- **Controls:** permission mode (Shift+Tab), model (newest first, older versions under "More models"),
  an effort slider from Low to Max plus Ultracode, fast mode, stop (Esc), Esc Esc to rewind.
  New conversations start in Auto mode, Medium effort, Opus 5.5 (change under Settings).
- **Review:** inline diffs with line numbers, permission prompts (keys 1/2/3), plan approval,
  Claude's multiple-choice questions, to-do progress, subagent and background-task output.
- **Undo:** edit or retry any message (forks the conversation), rewind code to before a message.
- **Agents:** browse subagents, mention them, or create a new one in `.claude/agents/`.
- **Panels:** Files, Changes (git status/diffs, discard, review/commit with Claude), Terminal,
  Preview (files, HTML/SVG/diagram artifacts, localhost dev servers), Tasks, Context usage,
  MCP servers (status, sign in, toggle, add/remove), Plugins (install/enable/update/marketplaces).
- **Rendering:** Markdown, syntax highlighting, LaTeX math, Mermaid diagrams.
- **Usage:** session and weekly limits with reset times, per-product split, what used it, and this
  conversation's cost (gauge button, status bar, or `/usage`). If a limit stops Claude mid-task, it
  continues on its own once the limit resets, even after an app restart.
- **Customization:** light/dark/system, four backgrounds, accent colors (or any custom color),
  interface/reading/code fonts, text size, width, density, corner style, animations, custom CSS.
- **Everything else:** command palette (Ctrl+K), find (Ctrl+F), pinned conversations, `/copy`,
  open files in your editor, your statusLine command, desktop notifications, a sound when done.

To stay light, Claude Code only starts for a tab once you type in it, stops after 15 idle minutes
(it resumes on its own), and the terminal and diagram engines load only when first used.

Shortcuts are listed under `/help`.
