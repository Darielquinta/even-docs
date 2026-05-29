# G2 Docs Keyboard v1.3.0

Local-only Bluetooth keyboard writing app for Even G2.

This version is built for **EHPK packaging**. It uses the Even app bridge storage APIs as the primary save system:

- `bridge.setLocalStorage(key, value)`
- `bridge.getLocalStorage(key)`

Browser `localStorage` is only used as a dev-preview fallback and an emergency mirror.

## Why this version exists

When an app is loaded from a dev server, regular browser `localStorage` / IndexedDB may work. When the app is packaged as an EHPK, the WebView origin and storage behavior can be different. This version stores the document vault through the Even app bridge, not regular browser storage.

## Build

```bash
npm install
npm run build
```

## Pack EHPK

```bash
npm run pack
```

The packed file will be:

```text
g2-docs-keyboard.ehpk
```

## Important

Keep this unchanged if you want the same storage bucket:

```json
"package_id": "com.dariel.g2docskeyboard"
```

Changing the package ID can make the app look like it lost documents because it may get a new local storage silo.

## Features

- Multiple local docs
- Local snapshots/version history
- Restore snapshots from the phone or glasses menu
- Export/import JSON backup
- EHPK-safe chunked local save storage
- Storage verification button
- Bigger documents stored locally, paged into the G2 display
- Bluetooth keyboard autofocus
- G2 page controls and glasses-side document menu
- Glasses scroll gestures page the document; tapping the document opens the glasses menu
- Markdown preview with simplified markdown text on G2

## Shortcuts

- Ctrl+S: save snapshot
- Ctrl+Shift+N: new document
- Ctrl+Shift+E: export backup
- Alt+Left/Right: page the G2 display
