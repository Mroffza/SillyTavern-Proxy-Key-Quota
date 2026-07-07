# SillyTavern Proxy Key Quota

A third-party [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that counts how many messages each API key / proxy has received, tracks which model was used, and keeps a timestamped history — all client-side, no external calls.

Built for the case where you rotate between several saved API keys (or reverse-proxy presets) and want to know how much each one has been used.

## Features

- **Counts every received message** — fires once per generation, covering both streaming and non-streaming responses (empty responses included). No double-counting.
- **Per-key tracking** — automatically identifies the key currently in use, in priority order:
  1. The active saved secret (the "Custom API Key" you selected in SillyTavern, by its label)
  2. The reverse-proxy password (hashed — the raw secret is never stored)
  3. The proxy preset name, then the proxy URL
- **Per-model breakdown** — records the model name used for each message, so you can see how a key's usage splits across models.
- **Timestamped history log** — every count is logged with a full 24-hour timestamp and the model used. Shows 10 rows by default, adjustable up to 1000.
- **On-screen counter** — a draggable badge that shows only the *currently selected* key's count. Works on both desktop and mobile (touch drag). Position is remembered.
- **"View all keys" page** — browse every key ever used via a dropdown / prev-next arrows, one card at a time (defaults to the key in use). Each card shows totals, latest model, per-model breakdown, and the history log, with a per-key delete button.
- **Enable / disable toggle** — from the settings panel or the extensions "wand" menu.
- **Export JSON** — dump all counters for backup or external processing.

## Installation

1. In SillyTavern, open **Extensions** → **Install extension**.
2. Paste this repository URL:
   ```
   https://github.com/Mroffza/SillyTavern-Proxy-Key-Quota
   ```
3. Install, then refresh (Ctrl+F5).

Or install manually by cloning into your extensions folder:

```bash
git clone https://github.com/Mroffza/SillyTavern-Proxy-Key-Quota \
  <SillyTavern>/public/scripts/extensions/third-party/proxy-key-quota
```

## Usage

After installing, a small counter badge appears on the chat screen showing the current key's total. Send a message and the number ticks up.

- Open the **Proxy Key Quota** panel under Extensions settings for the current-key summary and options.
- Click **ดูคีย์ทั้งหมด / View all keys** to browse every tracked key, see per-model stats, and view / trim the history log.
- Toggle counting on/off from the panel checkbox or the wand-menu button.
- Drag the on-screen badge anywhere; use **Reset widget position** to bring it back to the corner.

## How counting works

The extension listens for SillyTavern's `GENERATION_ENDED` and `MESSAGE_RECEIVED` events and counts a single message per generation using whichever fires first (a guard flag prevents streaming from counting twice). Dry runs (prompt assembly only) are skipped. Background / quiet generations are skipped by default but can be enabled.

## Limitations

This counts on the **client side** of *this* SillyTavern instance. It reflects messages sent through this browser only — it is not a server-side quota meter. If you need exact accounting across multiple users or devices sharing the same key/proxy, instrument the proxy or server itself. This extension is best for a single user keeping tabs on their own key rotation.

## License

[GNU AGPL v3.0](LICENSE) — same license as SillyTavern itself.
