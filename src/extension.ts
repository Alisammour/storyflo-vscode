// Storyflo VS Code extension.
//
// Three commands:
//   storyflo.narrateDocument   — render the whole markdown file as audio
//   storyflo.narrateSelection  — render just the highlighted text
//   storyflo.saveToQueue       — POST the current article URL to /v1/intake/web
//
// Audio renders open in a side-panel webview with a native <audio>
// player. We hit /v1/render directly (X-Storyflo-Key not required —
// the public endpoint accepts unauth reads up to the rate limit).
//
// Distribution lever: this puts Storyflo in the markdown editor where
// newsletter authors + technical writers actually draft. The save-to-
// queue command makes their drafts discoverable + agent-callable from
// the second they hit save.

import * as vscode from "vscode";
import * as https from "https";
import { URL } from "url";

const VOICE_CHOICES = ["atlas", "vox", "kira", "rune"];

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("storyflo.narrateDocument", () =>
      narrate(/* selectionOnly */ false),
    ),
    vscode.commands.registerCommand("storyflo.narrateSelection", () =>
      narrate(/* selectionOnly */ true),
    ),
    vscode.commands.registerCommand("storyflo.saveToQueue", saveToQueue),
  );
}

export function deactivate() {}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("storyflo");
  const voiceRaw = cfg.get<string>("voice") || "atlas";
  const voice = VOICE_CHOICES.includes(voiceRaw) ? voiceRaw : "atlas";
  const endpoint =
    (cfg.get<string>("endpoint") || "https://api.storyflo.com").replace(/\/$/, "");
  const publisherSlug = (cfg.get<string>("publisherSlug") || "").trim();
  return { voice, endpoint, publisherSlug };
}

// Strip markdown to readable text. Lightweight pass — we trust the
// inference side's `normalize_for_tts` step to handle the rest. Just
// the obvious noise (code fences, link syntax, headings markers).
function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/`[^`]*`/g, " ")        // inline code
    .replace(/^---[\s\S]*?---\s*/m, "") // frontmatter
    .replace(/!\[[^\]]*]\([^)]+\)/g, "") // images
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1") // links → label
    .replace(/^#{1,6}\s+/gm, "")     // heading markers
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // bold/italic
    .replace(/^>\s?/gm, "")           // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, "• ")  // bullets
    .replace(/^\s*\d+\.\s+/gm, "")    // numbered lists
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function narrate(selectionOnly: boolean) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Storyflo: no active editor.");
    return;
  }

  const raw = selectionOnly
    ? editor.document.getText(editor.selection)
    : editor.document.getText();
  if (!raw || raw.trim().length === 0) {
    vscode.window.showWarningMessage(
      selectionOnly
        ? "Storyflo: select some text first."
        : "Storyflo: this document is empty.",
    );
    return;
  }

  const text = markdownToPlain(raw);
  if (text.length < 20) {
    vscode.window.showWarningMessage(
      "Storyflo: not enough text to narrate (min ~20 chars after markdown strip).",
    );
    return;
  }

  const { voice, endpoint } = getConfig();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Storyflo · rendering audio (${voice})…`,
      cancellable: false,
    },
    async () => {
      try {
        const result = await renderAudio({ endpoint, voice, text });
        const panel = vscode.window.createWebviewPanel(
          "storyflo.audio",
          `Storyflo · ${voice} (${Math.round(result.duration_sec)}s)`,
          vscode.ViewColumn.Beside,
          { enableScripts: false },
        );
        panel.webview.html = audioWebviewHtml({
          audioUrl: result.audio_url,
          duration: result.duration_sec,
          provider: result.provider,
          voice,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Storyflo: render failed — ${msg}`);
      }
    },
  );
}

async function saveToQueue() {
  const url = await vscode.window.showInputBox({
    title: "Storyflo — save to queue",
    prompt: "Paste the article URL (or domain)",
    placeHolder: "https://yournewsletter.com/p/welcome-issue",
    validateInput(v) {
      const t = v.trim();
      if (!t) return "URL required";
      if (!t.includes(".")) return "That doesn't look like a URL";
      return null;
    },
  });
  if (!url) return;

  const normalized = /^https?:\/\//i.test(url.trim())
    ? url.trim()
    : `https://${url.trim().replace(/^\/+/, "")}`;

  const { endpoint, publisherSlug } = getConfig();

  try {
    const res = await postJson(`${endpoint}/v1/intake/web`, {
      url: normalized,
      ...(publisherSlug ? { publisher_slug: publisherSlug } : {}),
    });
    if (res.article) {
      const action = await vscode.window.showInformationMessage(
        `Storyflo: queued "${res.article.title || res.article.slug}".`,
        "Open story page",
      );
      if (action === "Open story page") {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://storyflo.com/story/${encodeURIComponent(res.article.slug)}`),
        );
      }
    } else {
      vscode.window.showInformationMessage(
        "Storyflo: already in your queue.",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Storyflo: save failed — ${msg}`);
  }
}

type RenderResult = {
  audio_url: string;
  duration_sec: number;
  provider: string;
  cache_hit: boolean;
};

async function renderAudio(opts: {
  endpoint: string;
  voice: string;
  text: string;
}): Promise<RenderResult> {
  const res = await postJson(`${opts.endpoint}/v1/render`, {
    voice: opts.voice,
    text: opts.text,
    speed: 1,
  });
  if (!res?.audio_url) {
    throw new Error("server returned no audio_url");
  }
  return res as RenderResult;
}

function postJson(url: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          "User-Agent": "storyflo-vscode/0.1.0",
        },
        timeout: 90_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error("invalid JSON response"));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("request timeout (90s)"));
    });
    req.write(payload);
    req.end();
  });
}

function audioWebviewHtml(opts: {
  audioUrl: string;
  duration: number;
  provider: string;
  voice: string;
}): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Storyflo audio</title>
<style>
  body {
    margin: 0;
    padding: 24px;
    font-family: var(--vscode-font-family, system-ui);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .meta {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
  }
  h1 {
    font-size: 18px;
    margin: 0 0 16px;
  }
  audio {
    width: 100%;
    margin-bottom: 12px;
  }
  .row {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-top: 6px;
  }
  a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
  <p class="meta">Storyflo · ${escapeHtml(opts.voice)} · ${opts.provider}</p>
  <h1>Audio render · ${Math.round(opts.duration)}s</h1>
  <audio controls autoplay src="${escapeHtml(opts.audioUrl)}"></audio>
  <p class="row">Source: <a href="${escapeHtml(opts.audioUrl)}">${escapeHtml(opts.audioUrl)}</a></p>
  <p class="row">Pricing: free at this length. Larger renders may meter against your Storyflo+ plan.</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
