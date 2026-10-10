# KeepVoice

Single-user shopping list in the spirit of Google Keep, with three ways in: type, speak, or photograph the product.
Static PWA, no backend. Data stays on the phone.

- Lists with tickable items. Ticked items move to "Bought before" and come back with one tap.
- Mic: Chrome's speech recognition (`en-ZA`), then one OpenRouter call turns the words into list actions.
- Camera: photo is shrunk on the phone and the same model names the product, brand and pack size.
- Without an API key, or offline, spoken words are added as plain items.
- Backup: Export / Import JSON from the menu. `seed.json` loads on first run; `#seed` merges it again without duplicates.

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

Speech recognition and the camera need HTTPS or `localhost`.
