# Storyflo — VS Code extension

Narrate any markdown file with [Storyflo](https://storyflo.com) — right
from your editor. Three commands, no API keys.

## Install

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=storyflo.storyflo) ·
[Open VSX](https://open-vsx.org/extension/storyflo/storyflo)

```bash
code --install-extension storyflo.storyflo
```

## What it does

| Command | What it does |
|---|---|
| `Storyflo: Narrate document` | Renders the whole markdown file as audio · opens in a side-panel player. |
| `Storyflo: Narrate selection` | Renders just the highlighted text. |
| `Storyflo: Save current article URL to queue` | POSTs to Storyflo so the article is auto-narrated for every listener. |

Right-click any `.md` or `.mdx` file to see the commands in the context
menu.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `storyflo.voice` | `atlas` | Voice for narration. One of `atlas` · `vox` · `kira` · `rune` |
| `storyflo.endpoint` | `https://api.storyflo.com` | Storyflo inference endpoint. |
| `storyflo.publisherSlug` | _(empty)_ | Your publisher slug (claim at storyflo.com/publisher/claim) — rev-share attributes here. |

## How it works

The extension talks directly to Storyflo's public inference API:

- `POST /v1/render` — synthesizes the markdown as audio (Kokoro / Piper TTS by default; ElevenLabs / Cartesia for premium voices)
- `POST /v1/intake/web` — saves your article URL to the public queue + enqueues a render

Audio renders are cached in Cloudflare R2 — first request renders, subsequent
requests with the same text return instantly from CDN.

## License

MIT
