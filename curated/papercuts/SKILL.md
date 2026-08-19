---
name: papercuts
description: "Log operational friction and broken tooling commands directly to Papercuts.md."
metadata:
  author: "OpenClaw Core Maintainers"
  original_source: "https://github.com/openclaw/openclaw"
  license: "MIT"
  curated_by: "benwiththelens"
  version: "1.0.0"
---

# Papercuts Skill

**Important!** When you hit a small friction while working—a tool call that missed and had to be retried, a confusing or undocumented setup step, a flaky command, a stale cache, a misleading error, a non-obvious gotcha—log it to `Papercuts.md`.

One or two sentences: what you were doing -> what got in the way (a guess at the cause/fix is a bonus). 

Do this proactively, in the moment, even though none of these are blocking—logged together they show where the repo needs sanding down. This is distinct from project logs (what you accomplished) and from real bugs / tracked work.

## Usage (PowerShell / Windows)
```powershell
pwsh -File ./papercut.ps1 "Your detailed friction description here"
```

## Usage (POSIX / Node.js)
```bash
node ./papercut.mjs "Your detailed friction description here"
```
