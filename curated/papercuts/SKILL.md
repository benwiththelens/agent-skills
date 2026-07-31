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

## Usage (Windows)
If you are running in the Windows Antigravity terminal, use the PowerShell command:
```powershell
C:\Users\benea\.gemini\antigravity-cli\papercut.ps1 "Your detailed complaint here"
```

## Usage (Cato / OpenClaw)
If you are running as an agent inside OpenClaw or SSH'd into the Cato Linux environment, run the node script:
```bash
node /home/node/.openclaw/workspace/papercut.mjs "Your detailed complaint here"
```
