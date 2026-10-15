# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-user shopping-list PWA (Google Keep style) for one Samsung phone. Static files only: no build step, no
bundler, no dependencies, no backend. Deployed by pushing `main`; GitHub Pages serves the repo root at
https://yourdesigncoza.github.io/keepvoice/. Data lives in the phone's `localStorage`.

## Commands

```
python3 -m http.server 8765        # local dev server (speech + camera need localhost or HTTPS)
node --check app.js                # the only "build" check there is
```

There are no tests. Verify behaviour in a browser at phone width (412x915). `window.KeepVoice` exposes
`handleUtterance(text)`, `handlePhoto(file)`, `execute(actions)`, `fallbackActions(text)`, `state` for
console-driven checks without a mic or camera.

## Shipping a change

- Every deploy needs a bump of `KV_VERSION` in `version.js`. It is the only version string: `sw.js` imports it for
  the cache name, `app.js` shows it in Settings and uses it for the "Updated to x" toast (`keepvoice.seen`).
  Without the bump, installed phones keep the old files.
- Any new static file must be added to `ASSETS` in `sw.js` or it will not be available offline.
- Update flow: the worker is network-first with cache fallback, calls `skipWaiting` + `clients.claim` on install,
  and `app.js` reloads the page on `controllerchange`. "Check for update" in Settings just calls `reg.update()`.

## Architecture

`app.js` is one IIFE, read top to bottom:

1. **State** – `{ lists, settings: { key }, lastList }` under `localStorage['keepvoice.v1']`. `snapshot()` before
   any mutation feeds an in-memory undo stack (depth 15, lost on reload).
2. **Mutations** – `createList`, `addItems`, `tickItem`, `removeItem`. Ticking never deletes: the item flips to
   `active:false`, `count++`, `lastDone`, and shows as a "bought before" chip that re-activates on tap.
3. **`execute(actions)`** – the entry point for everything that comes from words: voice, photo, the model and the
   no-key fallback all produce `{type: add|tick|untick|remove|clear|new_list|open_list|undo, items?, list?, name?}`
   and go through here. Item and list names are matched fuzzily (`score`/`best`), so model output does not have to
   be exact. An `add` whose `list` matches nothing creates that list. Direct UI taps (tick button, delete, chip,
   typed add) call the mutations themselves with the same `snapshot(); mutate; save(); render()` sequence.
4. **The model** – one OpenRouter call (`MODEL`, hardcoded) with `response_format: json_object`, temperature 0.
   `interpret(text)` turns speech into actions; `identify(dataUrl)` turns a shrunk photo (max 1024px JPEG) into
   `{label, sure}`. Both prompts carry `SA_NOTE` (the user shops in South Africa; fix mangled brand names) and
   `listContext()` (all list names, current list, to-buy, bought-before). The interpret prompt does the list routing:
   every `add` names a list, a list the user says wins, otherwise the model picks the list whose kind fits the item
   or invents a short name for `execute` to create. No key, offline, or a failed call falls back to
   `fallbackActions`: a leading verb is stripped and the words are split on commas/"and"/"plus"/"also" into items.
5. **Speech** – browser `SpeechRecognition`, `lang: en-ZA`, one utterance per mic tap, interim text shown in the
   bottom sheet. Works in Chrome on Android; Samsung Internet is unreliable, so the README tells the user to install
   from Chrome.
6. **UI** – hash routing (`#` home, `#list/<id>`), DOM built with the `el()` helper, full re-render on every change.
   Home shows the last-used list as the orange hero card; the rest are grid cards. Menu actions dispatch on
   `data-action` in `menuAction`.

Backup import goes through `mergeLists`, which merges by list id or name and by item name, so importing the same
file twice is harmless.

## Conventions worth keeping

- The user is ~60 and reads on a phone: type scale is deliberately large (base 18px, item rows 17px via `--fs-row`)
  and tap targets are 40px+. Do not shrink them to fit more on screen.
- Dialogs are `<dialog>` with `showModal()`. A document-level click handler closes any dialog when the backdrop is
  tapped (phones have no Esc). Keep that when adding dialogs.
- No nested buttons: the hero card is a `div[role=button]` because it contains the bought-before button.
- Simplicity is a stated requirement. The user rejected a rule-based parser and brand dictionary in favour of one
  model call; do not reintroduce parallel code paths for understanding input.
- Fonts are self-hosted (`fonts/outfit-latin.woff2`) so the app works offline; do not switch to a CDN link.
