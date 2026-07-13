# vite-plugin-claude-studio

A development-only side panel that lives inside your running Vite + React app
and gives you a context window straight into your local Claude Code. You
describe a change in plain language, Claude edits the real source files in
your project, and Vite hot-reloads the result in front of you. No separate
terminal, no copy-pasting file contents — the panel already knows what page
you're on and, if you point it at something on screen, exactly which
component you mean.

**This is a development tool, by design.** It runs `claude` as a subprocess
with full file-write access to your working tree, and it does so through a
set of HTTP endpoints mounted on the Vite dev server. None of that is
something you want anywhere near a production build. The plugin goes to
considerable lengths to guarantee it never ships (see "Production exclusion"
below), but you are still responsible for wiring the two integration points
correctly, and for never exposing your dev server beyond your own machine
while the Studio is active.

## Prerequisite

You need the `claude` CLI installed and logged in — the Studio shells out to
whatever `claude` resolves to on your `PATH`. If you can already run `claude`
from a terminal in your project directory, you're set. There's no separate
API key to configure: every run through the panel uses your own Claude
usage, exactly as if you'd typed the prompt into the CLI yourself.

## Install

```bash
npm i -D github:james-b-kelly/vite-plugin-claude-studio#v0.1.0
```

This installs straight from a git tag rather than a registry, which changes
one thing about how npm handles it: a git dependency has no prebuilt
package to download, so npm runs the package's `prepare` script — which
builds `dist/` — on your machine as part of the install. For that build to
succeed, npm also installs the package's own `devDependencies` (TypeScript,
Vite, etc.) even though you only asked for a dev dependency in your project;
that's normal behavior for git-hosted packages, not a misconfiguration. The
build itself uses only the toolchain already declared in this package — it
does not touch your project's `tsconfig.json` or `vite.config.ts`.

The package also declares peer dependencies your project must already
satisfy: `react` and `react-dom` at `>=18`, and `vite` at `>=5`. It requires
Node `>=20.19` to build and run.

## Setup

There are exactly two wiring points, and both are required.

First, add the plugin to your Vite config:

```ts
// vite.config.ts
import claudeStudio from "vite-plugin-claude-studio";

export default defineConfig({
  plugins: [react(), claudeStudio()],
});
```

This registers the `/__studio/*` middleware on the dev server. It does
nothing at build time beyond the safety measures described later — it never
adds routes, panel code, or client bundles to a production build.

Second, mount the panel from your app's entry point, gated behind
`import.meta.env.DEV`:

```ts
// your app entry (e.g. main.tsx)
if (import.meta.env.DEV) {
  void import("vite-plugin-claude-studio/panel").then((m) => m.mountStudioPanel());
}
```

The dynamic `import()` inside the `DEV` check matters as much as the check
itself: it's what lets Vite's bundler tree-shake the entire panel module
graph (React components, styles, the diff renderer, everything) out of a
production build, rather than merely hiding it behind a runtime flag while
still shipping the code. Don't refactor this into a static `import` — see
"Production exclusion" for why that would defeat the safeguard.

## Options

`claudeStudio()` takes a single optional `StudioOptions` object. Every field
has a sensible default, so calling it with no arguments works out of the
box.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `protectedBranches` | `string[]` | `["main", "release-*"]` | Branches the Studio refuses to run or commit on. Exact names, or a trailing `*` as a prefix wildcard. |
| `checks` | `{ label: string; command: string[] }[]` | `[{ label: "lint", command: ["npm", "run", "lint"] }, { label: "build", command: ["npx", "vite", "build"] }]` | The quality gate. Run on demand via "Check", and always re-run server-side before a commit. |
| `systemPrompt` | `string` | `""` | Extra project context appended to every prompt — house rules, conventions, anything Claude should know about this codebase that isn't obvious from the files. |
| `panel.buttonLabel` | `string` | `"◳ Studio"` | Text on the floating launch button. |
| `panel.accent` | `string` (any CSS color) | `"#3b6fe0"` | Accent color for primary actions in the panel UI. |
| `panel.position` | `"bottom-right" \| "top-right"` | `"bottom-right"` | Corner the floating launch button docks to. |
| `panel.appRootSelector` | `string` | `"#root"` | Selector for your app's root element. The panel docks by shrinking this element rather than overlaying it. |

A detached `HEAD`, or any failure to determine the current git branch, is
always treated as protected regardless of `protectedBranches` — there's no
way to opt out of that.

A fully-specified example:

```ts
claudeStudio({
  protectedBranches: ["main", "release-*"],
  checks: [
    { label: "lint", command: ["npm", "run", "lint"] },
    { label: "build", command: ["npx", "vite", "build"] },
  ],
  systemPrompt: "This app uses CSS modules; shared primitives live in src/ui/.",
  panel: {
    buttonLabel: "◳ Studio",
    accent: "#3b6fe0",
    position: "bottom-right",
    appRootSelector: "#root",
  },
})
```

Note that if you supply `checks` at all, it replaces the defaults entirely
rather than merging with them — an empty array is also treated as "use the
defaults," so pass at least one check if you want the gate to run
something other than lint and build.

## Using it

Start your dev server as usual and a small floating button appears in the
corner of your app (position and label controlled by `panel.position` and
`panel.buttonLabel`). Click it to open the panel.

The panel shows your current branch, whether it's protected, and whether
your working tree is dirty. Type a description of the change you want —
"add a loading spinner to the submit button," "extract this card into a
reusable component" — and hit Send (or Cmd/Ctrl+Enter). Claude reads your
project, makes the edit, and Vite hot-reloads it in the app behind the
panel.

Once a run finishes, the composer keeps the session open: further messages
become follow-ups that continue the same conversation, so you can say
"actually make it blue" without re-explaining what "it" is. The button
label changes from "Send" to "Refine" to reflect this. Click "↺ new" to
drop the session and start a fresh, unrelated conversation.

To point Claude at something specific on screen, click "⌖ Select," then
click any element in your app. That element gets pinned as extra context —
shown as a chip above the composer — and rides along with your next
message (and any follow-ups) until you clear it or pick something else.
This is the fastest way to disambiguate "fix the header" when your app has
several headers.

## Review loop

Every change the Studio makes lands as an ordinary uncommitted change in
your working tree — nothing is committed automatically. Once files have
changed, a review section appears listing them with badges for new,
modified, or deleted. "view diff" opens the full unified diff in a modal.

From there you have three actions:

- **Check** runs your configured quality gate (`checks`, default lint +
  build) against the current working tree and shows the output inline.
- **Revert all** restores tracked files to `HEAD` and deletes any new files
  the run created — a full undo of everything since the last commit. This
  is destructive and asks for confirmation first.
- **Commit & push** prompts for a commit message, then re-runs the checks
  itself, server-side, before doing anything else. If they fail, nothing is
  committed and you see why. If they pass, it stages everything, commits,
  rebases onto the shared branch if it has an upstream, and pushes. The
  Studio never commits or pushes on its own initiative — this button is
  always an explicit, deliberate action you take.

## Branch policy

The Studio refuses to start a run or accept a commit while you're on a
branch matching `protectedBranches` (`main` and `release-*` by default), and
refuses unconditionally on a detached `HEAD` or when the current branch
can't be determined at all. If you're on a protected branch, switch to a
working branch first — there's no override.

This is deliberately a working-branch-direct model, not a PR-per-change
model: the safety net is the quality gate re-run at commit time, not a
review-before-merge step. If your project needs a review step before code
lands on a shared branch, do your Studio work on a feature branch and open
your usual pull request from there.

## Production exclusion

Because the Studio drives an agent with real file-write access, it must be
structurally impossible for it to reach a production build — not just
disabled by a flag that could be misconfigured. Four independent layers
enforce this, each covering a different way the others could fail:

1. **Serve-only middleware.** The `/__studio/*` endpoints are registered
   inside Vite's `configureServer` hook, which only runs when the dev server
   is actually serving requests. There is no code path in a production build
   that ever calls it, so the endpoints — and the `claude` subprocess they
   can spawn — simply don't exist in anything you deploy.
2. **Your `import.meta.env.DEV` gate.** The dynamic `import()` in your app
   entry (see "Setup") is what keeps the panel's React components, styles,
   and client-side fetch calls out of the production JavaScript bundle
   entirely, via tree-shaking. This is the one layer that depends on code you
   wrote rather than code the plugin controls, which is why the other three
   exist as backstops.
3. **The build-time panel stub.** During a production build, the plugin's
   `load` hook intercepts any module resolving to `vite-plugin-claude-studio/panel`
   and replaces it with an empty no-op export (`mountStudioPanel` that does
   nothing). This means that even if your `DEV` gate were ever removed,
   loosened, or bypassed by some other import path, the module actually
   compiled into the bundle at that path is inert — there's no panel code
   behind it to run.
4. **The `generateBundle` marker assertion.** As a last resort, once a
   production build finishes assembling its chunks, the plugin scans every
   emitted chunk's source for Studio-specific markers (the `/__studio/`
   endpoint prefix and the panel's own identifying string). If either marker
   is found anywhere in a production chunk, the build fails outright with an
   error explaining that Studio code leaked and pointing at the `DEV` gate
   and the panel stub as the likely cause. This layer doesn't prevent a
   leak — it makes sure you can never ship one without your build turning
   red first. The scanned markers are the literal strings `/__studio/` and
   `In-App Studio` — if your own app legitimately contains one of these and
   your build fails, that assertion is why.

Together these mean a mistake in your own app code (layer 2) gets caught by
the plugin's own stubbing (layer 3), and a mistake in the plugin somehow
reaching that stub gets caught by the build failing loudly (layer 4) — while
the server-side attack surface (layer 1) never exists in a deployed artifact
regardless of any of the above.

## Security model

The `/__studio/*` endpoints are deliberately unauthenticated — there's no
login, token, or API key protecting them — because the Studio is designed
to be reached only by your own browser talking to your own dev server on
your own machine. Every request is checked against that assumption: it must
arrive on `localhost` (or `127.0.0.1`/`::1`), and if it carries an `Origin`
or `Sec-Fetch-Site` header, that header must also indicate the same origin.
Anything else — a request from another machine on your network, a
cross-site request from another tab, a request proxied through a hostname
other than localhost — is rejected with a 403 before it touches git or
spawns anything.

That check is a safety rail, not a substitute for keeping the dev server
private. The panel exists to let an agent make arbitrary file writes to
your project on your instruction, and that is exactly as powerful — and
exactly as dangerous in the wrong hands — as it sounds. In particular:

- **Never run your dev server with `vite --host`** (or any other
  LAN-exposing flag) while the Studio plugin is active. Doing so puts those
  endpoints on your local network, and same-origin checks alone are not a
  substitute for the isolation of not being reachable at all.
- Treat access to your dev server the same way you'd treat access to a
  terminal in your project directory, because functionally that's what it
  is.
- If you need to demo the running app to someone else, do it without the
  Studio plugin enabled, or over a tunnel/proxy you trust, not by exposing
  the dev server directly.
