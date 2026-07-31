#!/usr/bin/env node
/**
 * catalyst_runner.mjs
 * -------------------
 * Standalone link-ingestion runner — zero npm dependencies.
 *
 * Paste an article, YouTube/video, or PDF link; get a clean, structured
 * Markdown capture document written to your output directory.
 *
 * Pipelines:
 *   video (YouTube/TikTok/etc.)  yt-dlp audio → Gemini File API → transcript + synthesis
 *   pdf (*.pdf)                  direct download → Gemini File API → summary + key points
 *   article (everything else)    HTML fetch + text extraction → Gemini text prompt
 *
 * Configuration (environment variables):
 *   GEMINI_API_KEY           (required) Gemini API key
 *   CATALYST_OUTPUT_DIR      default: ./captures
 *   CATALYST_MODEL           default: gemini-2.5-flash
 *   CATALYST_FALLBACK_MODEL  default: gemini-2.0-flash
 *   CATALYST_YT_DLP_BIN      default: yt-dlp
 *   CATALYST_FFMPEG_BIN      default: ffmpeg
 *   CATALYST_TAGS            default: mindset,capture  (comma-separated)
 *
 * Usage:
 *   node catalyst_runner.mjs <URL>
 *
 * License: MIT
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_KEY = process.env.GEMINI_API_KEY || '';
const OUTPUT_DIR = process.env.CATALYST_OUTPUT_DIR || path.join(process.cwd(), 'captures');
const MODEL = process.env.CATALYST_MODEL || 'gemini-2.5-flash';
const FALLBACK_MODEL = process.env.CATALYST_FALLBACK_MODEL || 'gemini-2.0-flash';
const YT_DLP_BIN = process.env.CATALYST_YT_DLP_BIN || 'yt-dlp';
const FFMPEG_BIN = process.env.CATALYST_FFMPEG_BIN || 'ffmpeg';
const TAGS = (process.env.CATALYST_TAGS || 'mindset,capture').split(',').map(t => t.trim()).filter(Boolean);

const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'tiktok.com', 'twitter.com', 'x.com', 'vimeo.com', 'instagram.com'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg) { console.log(`[catalyst] ${msg}`); }

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeSlug(slug) {
  return slug.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `capture-${Date.now()}`;
}

/** Classify the URL into a pipeline: 'video' | 'pdf' | 'article' */
function classifyUrl(url) {
  const lower = url.toLowerCase();
  if (lower.split('?')[0].endsWith('.pdf')) return 'pdf';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (VIDEO_HOSTS.some(v => host === v || host.endsWith('.' + v))) return 'video';
  } catch { /* fall through to article */ }
  return 'article';
}

/** Best-effort HTML → plain text extraction (zero-dependency). */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|article|section|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Gemini API — file upload + generation (with model fallback)
// ---------------------------------------------------------------------------
async function uploadFileToGemini(buffer, mimeType, displayName) {
  log(`📤 Uploading ${(buffer.length / 1024 / 1024).toFixed(2)} MB to Gemini File API...`);

  const initRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': buffer.length.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file: { display_name: displayName } })
    }
  );

  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error(`Failed to initiate upload: ${await initRes.text()}`);

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': buffer.length.toString(),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: buffer
  });

  const data = await uploadRes.json();
  if (!data.file?.uri || !data.file?.name) {
    throw new Error(`Upload failed: ${JSON.stringify(data).slice(0, 500)}`);
  }
  log(`✅ Uploaded: ${data.file.uri}`);
  return { uri: data.file.uri, name: data.file.name };
}

async function deleteGeminiFile(fileName) {
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${API_KEY}`, { method: 'DELETE' });
    log('🗑️  Remote Gemini file storage sanitized.');
  } catch (e) {
    log(`⚠️  Remote file cleanup failed (non-fatal): ${e.message}`);
  }
}

/** Call generateContent with fileData and/or text, falling back to FALLBACK_MODEL. */
async function generate(parts) {
  for (const model of [MODEL, FALLBACK_MODEL]) {
    log(`🧠 Generating via ${model}...`);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.1 }
          })
        }
      );
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
      log(`⚠️  ${model} returned no text — ${data.error?.message || 'empty candidates'}`);
    } catch (e) {
      log(`⚠️  ${model} request failed: ${e.message}`);
    }
  }
  throw new Error('Gemini generation failed on both primary and fallback models.');
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------
function buildPrompt(url, kind) {
  const tagYaml = TAGS.map(t => `  - ${t}`).join('\n');
  const extractionHeader = kind === 'video' ? '🎙️ FULL TRANSCRIPTION' : '📄 KEY EXTRACTION';
  const extractionInstr = kind === 'video'
    ? 'High-fidelity verbatim transcription of the audio.'
    : 'A thorough, structured extraction of the key content, arguments, data points, and quotes.';

  return `You are a meticulous knowledge capture engine. Process the attached ${kind === 'article' ? 'article text' : kind} and output a single high-fidelity Markdown capture document.

On the very first line of your response, output a clean, semantic filename slug like this:
FILENAME: [semantic-filename-slug]
(No spaces, hyphens only, directly based on the content, no date prefix.)

Format the rest of the output exactly as follows:
---
type: capture
date: ${dateStr()}
source: ${url}
tags:
${tagYaml}
---
# [Clean Title]

> [!abstract] Key Essence
> [Concise summary of the core idea or mindset shift]

---

## ${extractionHeader}
[${extractionInstr}]

---

## 🧠 CORE TAKEAWAYS
[Deep-dive analysis of the underlying logic. Why does this work? How should a builder/operator integrate it into daily practice?]`;
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------
function extractAudio(url, tmpAudio) {
  log('📥 Downloading and extracting audio via yt-dlp...');
  const args = ['--ffmpeg-location', path.dirname(FFMPEG_BIN), '-x', '--audio-format', 'mp3', '-o', tmpAudio, url];
  try {
    execFileSync(YT_DLP_BIN, args, { stdio: 'inherit' });
  } catch (e) {
    throw new Error(`yt-dlp failed (is it installed? is ffmpeg available?): ${e.message}`);
  }
  if (!fs.existsSync(tmpAudio)) throw new Error('yt-dlp completed but no audio file was produced.');
  return fs.readFileSync(tmpAudio);
}

async function downloadToBuffer(url, contentTypeHint) {
  log(`📥 Downloading ${url}...`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; catalyst-runner/1.0)' },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = contentTypeHint || res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  return { buffer, contentType };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const url = process.argv[2];
  if (!url || args_help(url)) {
    console.log(`Usage: node catalyst_runner.mjs <URL>

Ingests an article, YouTube/video, or PDF link and writes a structured
Markdown capture to $CATALYST_OUTPUT_DIR (default: ./captures).

Required env: GEMINI_API_KEY
Optional env: CATALYST_OUTPUT_DIR, CATALYST_MODEL, CATALYST_FALLBACK_MODEL,
              CATALYST_YT_DLP_BIN, CATALYST_FFMPEG_BIN, CATALYST_TAGS`);
    process.exit(url ? 0 : 1);
  }
  if (!API_KEY) {
    console.error('Error: GEMINI_API_KEY is not set.');
    process.exit(1);
  }

  const kind = classifyUrl(url);
  log(`🚀 Ingesting [${kind}]: ${url}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-'));
  const tmpAudio = path.join(tmpDir, 'audio.mp3');
  let remoteFileName = null;

  try {
    let parts;

    if (kind === 'video') {
      const audio = extractAudio(url, tmpAudio);
      const uploaded = await uploadFileToGemini(audio, 'audio/mp3', `catalyst_${Date.now()}`);
      remoteFileName = uploaded.name;
      parts = [
        { fileData: { mimeType: 'audio/mp3', fileUri: uploaded.uri } },
        { text: buildPrompt(url, kind) }
      ];
    } else if (kind === 'pdf') {
      const { buffer } = await downloadToBuffer(url, 'application/pdf');
      const uploaded = await uploadFileToGemini(buffer, 'application/pdf', `catalyst_${Date.now()}`);
      remoteFileName = uploaded.name;
      parts = [
        { fileData: { mimeType: 'application/pdf', fileUri: uploaded.uri } },
        { text: buildPrompt(url, kind) }
      ];
    } else {
      const { buffer } = await downloadToBuffer(url);
      const text = htmlToText(buffer.toString('utf8'));
      if (text.length < 200) throw new Error('Extracted article text is suspiciously short — the page may be JS-rendered or paywalled.');
      log(`📄 Extracted ${text.length} chars of article text.`);
      // Guard against blowing the context window on huge pages
      const clipped = text.slice(0, 120_000);
      parts = [{ text: buildPrompt(url, kind) + '\n\nARTICLE TEXT:\n' + clipped }];
    }

    const output = await generate(parts);

    // Extract FILENAME slug + body
    let slug = `capture-${Date.now()}`;
    let body = output.trim();
    if (body.startsWith('FILENAME:')) {
      const lineEnd = body.indexOf('\n');
      slug = body.slice(0, lineEnd).replace('FILENAME:', '').trim();
      body = body.slice(lineEnd + 1).trim();
    }

    const finalName = `${sanitizeSlug(slug)}-${dateStr()}.md`;
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const finalPath = path.join(OUTPUT_DIR, finalName);
    fs.writeFileSync(finalPath, body, 'utf8');
    log(`💾 Capture saved: ${finalPath}`);
    console.log(finalPath); // machine-readable last line for callers
  } finally {
    if (remoteFileName) await deleteGeminiFile(remoteFileName);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    log('🧹 Local temp files cleared.');
  }
}

function args_help(arg) {
  return arg === '--help' || arg === '-h' || arg === 'help';
}

main().catch(e => {
  console.error(`❌ Ingestion failed: ${e.message}`);
  process.exit(1);
});
