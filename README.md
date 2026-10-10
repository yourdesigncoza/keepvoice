<img width="1140" height="1065" alt="image" src="https://github.com/user-attachments/assets/bae9436a-8904-4ae9-9126-36e2c6212216" />

# KeepVoice

Single-user shopping list in the spirit of Google Keep, with three ways in: type, speak, or photograph the product.
Static PWA, no backend. Data stays on the phone.

Live at https://yourdesigncoza.github.io/keepvoice/

- Lists with tickable items. Ticked items move to "Bought before" and come back with one tap.
- Mic: Chrome's speech recognition (`en-ZA`), then one OpenRouter call turns the words into list actions.
- Items land on the list that fits them (food on groceries, screws on hardware) and a missing list is created.
- Camera: photo is shrunk on the phone and the same model names the product, brand and pack size.
- Without an API key, or offline, spoken words are added as plain items.
- Backup: Export / Import JSON from the menu. Import merges by list and item name, so it never duplicates.

## Install on the phone

1. Open the link above in **Chrome** (Samsung Internet's speech recognition is unreliable).
2. Menu (⋮) → **Install app**, or Chrome's own "Add to Home screen".
3. Menu → **Settings** → paste an OpenRouter API key → Save. Voice understanding and photos need it.

## Voice commands

- `add milk, eggs and bread` / `I need butter` / just `tomatoes`
- `add screws to hardware` (targets another list)
- `tick off milk` / `done with eggs` / `bought bread`
- `remove tomatoes` · `put back eggs` · `clear the list` · `undo`
- `new list hardware` · `open groceries`

## Updates

The app updates itself the next time it is opened online. Settings shows the installed version and has a
**Check for update** button if it seems stuck.

## Run locally

```
python3 -m http.server 8765
```

Speech recognition and the camera need HTTPS or `localhost`.
