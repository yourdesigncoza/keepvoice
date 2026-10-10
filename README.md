# KeepVoice

Single-user, voice-first list app in the spirit of Google Keep. Static PWA, no backend.

- Lists with checkable items. Ticked items move to a "Previously bought" strip and can be re-added with one tap.
- Mic button uses the browser's speech recognition (Chrome on Android) plus a rule-based command parser.
- Optional: route transcripts through an OpenRouter model for looser phrasing (Settings).
- Data lives in `localStorage`; Export/Import JSON from the menu for backup.

## Voice commands

- `add milk, eggs and bread` / `I need butter` / just `tomatoes`
- `add screws to hardware` (targets another list)
- `tick off milk` / `done with eggs` / `bought bread`
- `remove tomatoes` · `put back eggs` · `clear the list` · `undo`
- `new list hardware` · `open groceries`

## Run locally

```
python3 -m http.server 8765
```

Speech recognition needs HTTPS or `localhost`.
