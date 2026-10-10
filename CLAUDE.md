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
`handleUtterance(text)`, `handlePhoto(file)`, `execute(actions)`, `state` for console-driven checks
without a mic or camera.

Every deploy needs a bump of `KV_VERSION` in `version.js`. It is the only version string: `sw.js` imports it for the
cache name (so the browser sees a changed worker and swaps caches) and Settings displays it. Without the bump,
installed phones keep the old files.

## Architecture

`app.js` is one IIFE, read top to bottom:

1. **State** – `{ lists, settings: { key }, lastList }` under `localStorage['keepvoice.v1']`. `snapshot()` before
   any mutation feeds an in-memory undo stack.
2. **Mutations** – `createList`, `addItems`, `tickItem`, `removeItem`. Ticking never deletes: the item flips to
   `active:false`, `count++`, `lastDone`, and shows as a "bought before" chip that re-activates on tap.
3. **`execute(actions)`** – the single entry point for changing data. Voice, photo, typed input and the model all
   produce `{type: add|tick|untick|remove|clear|new_list|open_list|undo, items?, list?, name?}` and go through here.
   Item and list names are matched fuzzily (`score`/`best`), so model output does not have to be exact.
4. **The model** – one OpenRouter call (`MODEL`, hardcoded) with `response_format: json_object`. `interpret(text)`
   turns speech into actions; `identify(dataUrl)` turns a photo into `{label, sure}`. Both prompts carry `SA_NOTE`
   (the user shops in South Africa; fix mangled brand names) and `listContext()` (current list, to-buy, bought-before)
   so the model prefers names already in the lists. No key, offline, or a failed call falls back to
   `fallbackActions`: the words are split on commas/"and" and added as items.
5. **Speech** – browser `SpeechRecognition`, `lang: en-ZA`, one utterance per mic tap. Works in Chrome on Android;
   Samsung Internet is unreliable, so the README tells the user to install from Chrome.
6. **UI** – hash routing (`#` home, `#list/<id>`), DOM built with the `el()` helper, full re-render on every change.
   Home shows the last-used list as the orange hero card; the rest are grid cards.

Backup import goes through `mergeLists`, which merges by list id or name and by item name, so importing the same
file twice is harmless.

## Conventions worth keeping

- The user is ~60 and reads on a phone: type scale is deliberately large (base 18px, items 20px) and tap targets
  are 40px+. Do not shrink them to fit more on screen.
- Dialogs are `<dialog>` with `showModal()`. A document-level click handler closes any dialog when the backdrop is
  tapped (phones have no Esc). Keep that when adding dialogs.
- No nested buttons: the hero card is a `div[role=button]` because it contains the bought-before button.
- Simplicity is a stated requirement. The user rejected a rule-based parser and brand dictionary in favour of one
  model call; do not reintroduce parallel code paths for understanding input.
- Fonts are self-hosted (`fonts/outfit-latin.woff2`) so the app works offline; do not switch to a CDN link.
