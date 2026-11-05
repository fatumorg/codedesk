# Codedesk theme logo + website — Design

Date: 2026-11-05
Status: approved by partner

## Part A: Theme-aware logo (fix)

**Intent:** The top-left brand mark and the empty-state welcome mark show a static SVG whose chevron accent is baked in (`#d97757`). Changing a theme accent swatch has no effect on those marks.

**Root cause:** `ui/index.html:21` and `ui/index.html:58` (`.welcome-mark`) and `ui/pair.html:25` all use `<img src=".../icon.svg">`. The file `build/icon.svg` is static and cannot reference CSS variables. The accent is set via `--accent` on `document.documentElement` in `ui/lib.js:applySettings()`, but `<img>` is opaque to CSS variables.

**Change:** Replace each `<img>` with an inlined SVG. The background rectangle and cream cursor dot stay as-is (`#1f1e1c` / `#f3efe6`). The chevron's `stroke` becomes `var(--accent)`. `build/icon.svg` is left untouched (used by the Electron app icon, the Nix flake, and the PWA manifest).

**Files changed:**
- `ui/index.html` — line 21 (brand), line 58 (welcome-mark)
- `ui/style.css` — add rule for `.brand .mark` (same sizing as current `.brand img`), add rule for `.welcome-mark` to size the inline SVG
- `ui/pair.html` — line 25 (brand) — inline the same SVG; no CSS change needed (pair.html already has `.brand img` inline; replace the selector)

**Acceptance:** After switching any accent swatch or custom color (including light/dark theme toggle), both the sidebar brand mark and the welcome-mark show the new accent color on the chevron. No visual regression on any other element.

---

## Part B: Codedesk website

### Intent and why

A landing page for developers who already use Claude Code, to convince them to install Codedesk as their desktop workspace. The page should feel immersive and alive: the product demonstrates itself through motion and interactive demos rather than static screenshots.

### Goals

- First impression: impress a technical visitor deciding whether to install.
- Communicate the core value prop: Claude working across your entire workspace.
- Showcase the product's real features through interactive demos, not marketing fluff.
- Zero dependencies. Zero build step. Works from a single `site/` directory.

### Non-goals

- No pricing, no testimonials, no login, no blog, no newsletter signup.
- No CMS, no i18n, no analytics tracking.
- No framework, no bundler, no npm packages.

### Constraints

- Vanilla HTML/CSS/JS only. No React, no Tailwind, no GSAP, no Motion.
- Native CSS scroll-driven animations (`animation-timeline`) where supported, with IntersectionObserver as the base.
- Every animation gated by `prefers-reduced-motion`.
- Single dark theme. No mid-page theme switches.
- Mobile-friendly: single-column layout under 768px. No parallax on mobile.
- Zero em-dashes on the page.
- Real content from the repo (README highlights, real screenshots). No fake stats or numbers.
- Page has ONE accent color at any time. Once the user picks a swatch, that color is used identically across all sections.
- One corner-radius system per page (use `8px`).

### What the partner decided

- Audience: a developer deciding whether to install Codedesk.
- Vibe: dark, cinematic, "workshop" feel. The user said "surprise me" for creative direction.
- Motions: two objects in the middle connect during animation; everything else slides in; mouse-reactive elements. Mobile-friendly.
- Stack: consistent with the existing repo — vanilla, no framework.
- Theme: dark-locked. Accent swatch retinting is the interactive theming feature.

### Builder decisions (no further input needed)

- Fonts: copy `geist`, `geist-mono`, and `newsreader` woff2 files from `node_modules/@fontsource-variable/` into `site/fonts/`. Serve them via a local `@font-face` + a `style.css` in `site/fonts/`. No CDN links.
- Icons: inline only the 4 Phosphor glyphs the site actually needs (copy-paste, download, arrow-right, external-link) as inline SVGs. No full icon library.
- Assets: copy the 4 repo screenshots into `site/screenshots/` (chat.png, effort.png, light.png, workspace.png; 133–258k each).
- Deployment: self-contained static directory. Where it's hosted is a partner decision, not a build dependency.

### Builder decisions (partner delegated)

- Hero conversation: crafted demo using real app concepts (settings, themes, workspaces from the README) with placeholder text that reads like a real Codedesk conversation. Not fake stats — a plausible demo exchange showcasing the product.
- Effort slider: visual replica only on the landing page. No IPC to the app.
- Review section diff: a real diff from the repo's git history (builder grabs a recent meaningful commit).

### Design tokens

| Token | Value |
|---|---|
| `--bg` | `#1f1e1c` |
| `--surface` | `#282622` |
| `--surface-2` | `#2e2d2a` |
| `--fg` | `#f3efe6` |
| `--fg-2` | `#c9c6be` |
| `--accent` | `#d97757` (default, follows swatch on retint) |
| `--accent-soft` | `rgba(217, 119, 87, 0.18)` |
| `--border` | `rgba(243, 239, 230, 0.08)` |
| `--border-strong` | `rgba(243, 239, 230, 0.18)` |
| `--radius` | `8px` |

Fonts: Newsreader Variable (display), Geist Variable (body), Geist Mono Variable (code). All local, no web requests.

### Page structure

#### 1. Navigation (single row, one line on desktop)

Logo (inlined SVG, chevron follows `--accent`) + "Codedesk" on the left. Right side: "Install" link, GitHub icon, "Download" button. Max 72px height. Collapses to hamburger under 768px.

#### 2. Hero — two objects connect

Full viewport, no scroll to find anything.

Left: workspace card. Shows a file tree with three folders: `app/`, `api/`, `design-system/`. Slides in from the left.

Right: Codedesk conversation window. A live mini-replica of the app UI. Slides in from the right.

Animation: a line of light draws from the workspace card into the conversation window. Then the conversation *plays*: a prompt types in, Claude's reply streams in token by token, an inline diff appears line by line, and a permission prompt shows keys `1 2 3`.

The two connecting objects are Codedesk's literal promise: Claude works across your entire workspace.

Mouse: subtle parallax on both cards (3–5px, lazy easing). Soft glow under the cursor (pointer: fine only). Mobile: no parallax, no glow. Cards stack vertically. The conversation demo stays in a single column.

#### 3. Workspaces

As the user scrolls, three folder cards appear one by one (staggered). Claude's cursor line hops between them. The section headline reads: "Add more folders. Claude reads and edits all of them."

#### 4. Review everything

A pinned scroll section. A real inline diff (from the repo) sits on the left. On the right, the permission prompt with `1 2 3` keys. As the user scrolls, lines of the diff highlight in sequence, then the permission prompt lights up.

#### 5. Effort

The actual effort slider from the app. Drag it from Low → Max → Ultracode and the model badge on screen changes accordingly. Playful interactivity. No explanation needed — the slider speaks for itself.

#### 6. Make it yours

The seven real accent swatches from the app (Terracotta, Ocean, Forest, Rose, Amber, Plum, Graphite). Clicking one re-tints the entire page: buttons, links, the nav CTA, the logo. This is the fix demo'd in the live page.

#### 7. Still shots

A 2x2 asymmetric grid of the four real screenshots (chat, effort, light, workspace). Hover: slight scale + border highlight. Click: opens full-screen in a lightweight overlay.

#### 8. Install

Three tiles:

- **NixOS / Nix** — `nix run .` + note about adding to system packages.
- **Everything else** — `npm install` then `npm start`.
- **Phone** — brief mention of Tailscale pairing, link to README.

One copy-pasteable command per tile. Copy button on each.

#### 9. Footer

"Built with Claude Code" + MIT license note. No locale strips, no version footers, no decorative text.

### Motion system

| Motion | How | Reduced motion |
|---|---|---|
| Hero slide-in | CSS `@keyframes` + `animation-timeline: view()` or IntersectionObserver | No animation, both cards visible |
| Light line draw | CSS `stroke-dashoffset` animation (scroll-driven or triggered) | No animation |
| Parallax | `transform: translateX()` driven by `pointermove`, throttled to rAF | Off |
| Cursor glow | `pointermove` → inline style on fixed element | Off |
| Section reveals | IntersectionObserver → add `.visible` class → CSS transition | No transition |
| Live conversation | Token-by-token DOM insertion, 30ms delay | Static pre-rendered conversation |
| Effort slider | Native range input, visual feedback on `input` event | Same |
| Swatch retint | CSS transition on `--accent` via inline style on `:root` | Instant |

### Copy rules

- Tone: direct, concrete, no fluff. Match the README's voice.
- Headlines: max 8 words. Subtext: max 25 words.
- No fake numbers, no "quietly trusted by," no weather strips, no scroll cues, no decorative dots, no section-number eyebrows, no em-dashes.
- One CTA label per intent. "Download" is the one download/install CTA.
- No generic names, no filler verbs ("elevate," "seamless," "unleash").

### Acceptance

- Hero fits the viewport. No scroll to see the CTA.
- All animations run on desktop. All collapse to static under `prefers-reduced-motion`.
- Mobile: single column, no horizontal overflow, all interactive elements usable in portrait.
- Swatch click re-tints the entire site including the logo mark.
- Zero console errors. No em-dashes on the page.
- Loads fast: fonts are local, images are self-contained, no external requests.
