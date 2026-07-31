---
name: catalyst-ingest
description: Standalone link-ingestion runner — paste an article, YouTube/video, or PDF link and get a clean, structured Markdown capture document (summary, transcript/key points, actionable takeaways) via the Gemini API. Zero npm dependencies.
author: "Ben Weber (@benwiththelens) & VANTAGE"
license: MIT
---

# Catalyst Ingest

A standalone ingestion pipeline that turns any link into a high-signal Markdown
capture document. Paste an article, a YouTube/TikTok/video link, or a PDF, and
the runner extracts the content, sends it through the Gemini API, and writes a
clean, structured Markdown file to your captures folder — ready for Obsidian,
a blog pipeline, or any knowledge vault.

## What It Handles

| Input type        | Pipeline                                                        |
| ----------------- | --------------------------------------------------------------- |
| YouTube / video   | `yt-dlp` audio extraction → Gemini File API → transcript + synthesis |
| PDF (`*.pdf`)     | Direct download → Gemini File API → summary + key points        |
| Article / blog    | HTML fetch + text extraction → Gemini text prompt → synthesis   |

## Requirements

- Node.js 18+ (native `fetch`)
- A **Gemini API key** (`GEMINI_API_KEY`)
- For video links only: [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and
  `ffmpeg` on your `PATH` (or override the binary paths via env vars)
- No npm dependencies.

## Configuration

All configuration is via environment variables:

| Variable                | Required   | Default            | Purpose                                |
| ----------------------- | ---------- | ------------------ | -------------------------------------- |
| `GEMINI_API_KEY`        | ✅         | —                  | Gemini API key                         |
| `CATALYST_OUTPUT_DIR`   |            | `./captures`       | Where Markdown captures are written    |
| `CATALYST_MODEL`        |            | `gemini-2.5-flash` | Primary generation model               |
| `CATALYST_FALLBACK_MODEL` |          | `gemini-2.0-flash` | Fallback if the primary model errors   |
| `CATALYST_YT_DLP_BIN`   |            | `yt-dlp`           | Path/name of yt-dlp binary             |
| `CATALYST_FFMPEG_BIN`   |            | `ffmpeg`           | Path/name of ffmpeg binary             |
| `CATALYST_TAGS`         |            | `mindset,capture`  | Comma-separated tags for frontmatter   |

## Usage

```bash
# YouTube / video → verbatim transcript + mindset synthesis
GEMINI_API_KEY=... node catalyst_runner.mjs "https://youtube.com/watch?v=..."

# PDF → structured summary + key points
node catalyst_runner.mjs "https://example.com/paper.pdf"

# Article / blog post → essence + takeaways
node catalyst_runner.mjs "https://someblog.com/great-post"
```

Output lands at:

```
$CATALYST_OUTPUT_DIR/[semantic-slug]-[YYYY-MM-DD].md
```

The model proposes the filename slug on the first line of its response
(`FILENAME: some-slug`); the runner sanitizes it and appends the date.

## Output Document Shape

```markdown
---
type: capture
date: 2026-07-31
source: <original URL>
tags:
  - mindset
  - capture
---
# [Clean Title]

> [!abstract] Key Essence
> [Concise summary of the core idea]

## 🎙️ FULL TRANSCRIPTION / 📄 KEY EXTRACTION   (depends on input type)
[Verbatim transcript for media, structured extraction for articles/PDFs]

## 🧠 CORE TAKEAWAYS
[Actionable analysis — why it works, how to apply it]
```

## Agent Integration Guidance

1. **Trigger on intent.** When a user pastes a link with a "save this" /
   "ingest" / "capture" intent, run the runner with the URL as the only argument.
2. **Read the output back.** After the runner finishes, read the generated
   Markdown file and present the *Key Essence* and *Core Takeaways* in chat,
   referencing the exact output path. Don't dump the full transcript.
3. **Fail loudly, not silently.** The runner exits non-zero on failure and
   cleans up temp files + remote Gemini file uploads in a `finally` block —
   surface the error message verbatim to the user.

---
*Portability: any machine with Node 18+ · yt-dlp/ffmpeg only needed for video · zero npm dependencies*
