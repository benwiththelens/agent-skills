# ⚙️ agent-skills

> **Industrial-grade skill collection for autonomous agent runtimes.**
> Original builds + battle-tested community curation by [@benwiththelens](https://github.com/benwiththelens).

```
┌──────────────────────────────────────────────────────────────┐
│  benwiththelens / agent-skills                               │
│  ─────────────────────────────────────────────               │
│  Runtime targets: OpenClaw · Claude Code                     │
│  License: MIT                                                │
│  Status:  ACTIVE MAINTENANCE                                 │
└──────────────────────────────────────────────────────────────┘
```

A modular repository of agent skills — reusable, self-contained capability
packages (each a `SKILL.md` plus supporting files) that teach an agent *how*
to perform a specialized task. Drop them into your runtime's skills directory
and they become available on demand.

---

## 🚀 Featured: Autonomous Jules Pipeline v2

The `jules-dispatch` skill has been upgraded to **v2** — a fully autonomous,
event-driven development architecture for Google Jules. Key capabilities:

- **Graphify AST Enrichment:** Prompts are injected with exact Abstract Syntax
  Tree (AST) node dependencies, types, and file relationships — no more blind
  codebase dumps.
- **Rate-Limit Safety Buffers:** Daily automated cap (80/100) with a
  20-session manual reserve buffer to prevent quota exhaustion.
- **Autonomous Feedback Resolution:** When Jules pauses for feedback or plan
  approval, an OpenClaw subagent inspects the git patch, resolves the blocker,
  and approves execution.
- **Kimi k3 / Multi-Model Audit Gatekeeping:** PRs are never blindly trusted.
  High-reasoning models (`moonshot/kimi-k3`, `gemini-3.7-flash`) audit diffs
  for security, compliance, and logic before merge.

See [`original/jules-dispatch/DESIGN_SPEC.md`](original/jules-dispatch/DESIGN_SPEC.md)
for the full architecture specification.

---

## 📦 Repository Layout

```
agent-skills/
├── original/        # Skills authored from scratch by benwiththelens
│   ├── jules-dispatch/
│   ├── server-ops/
│   └── catalyst-ingest/
├── curated/         # Community skills, reviewed & hardened
│   ├── papercuts/
│   ├── voice-builder/
│   ├── self-improving-agent/
│   └── obsidian-skills/
├── scripts/         # Maintenance / sync / validation tooling
├── install.sh       # One-shot installer (symlink or copy)
└── README.md        # You are here
```

---

## 🚀 Installation

### Quickstart

```bash
git clone https://github.com/benwiththelens/agent-skills.git
cd agent-skills
./install.sh
```

The installer auto-detects your runtime and **symlinks** the collection into it:

| Runtime     | Install target                                  |
| ----------- | ----------------------------------------------- |
| OpenClaw    | `~/.openclaw/workspace/skills/benwiththelens`   |
| Claude Code | `~/.claude/skills/benwiththelens`               |

### Options

```bash
./install.sh --copy              # copy instead of symlink (no live updates)
./install.sh --target /path/to/skills   # explicit install directory
./install.sh --uninstall         # remove the installed link/copy
./install.sh --help              # usage summary
```

### Verify

After installing, restart your agent runtime (or re-scan skills) and confirm
the skills appear in your available-skills list. In OpenClaw:

```bash
openclaw skills check
```

---

## 🗂️ Master Skill Catalog & Attribution

### Original Skills — authored by `benwiththelens`

| Skill             | Path                        | Description                                                        |
| ----------------- | --------------------------- | ------------------------------------------------------------------ |
| `jules-dispatch`  | `original/jules-dispatch/`  | Autonomous Jules Pipeline v2 — queue-based async dispatcher with Graphify AST enrichment, rate-limit safety buffers, autonomous feedback resolution, and Kimi k3 / multi-model audit gatekeeping. |
| `server-ops`      | `original/server-ops/`      | Headless server/container operations: health, logs, Docker lifecycle.  |
| `catalyst-ingest` | `original/catalyst-ingest/` | Structured ingestion pipeline for raw captures into the knowledge vault. |

### Curated Community Skills — reviewed & hardened

| Skill                  | Path                             | Upstream / Attribution                     |
| ---------------------- | -------------------------------- | ------------------------------------------ |
| `papercuts`            | `curated/papercuts/`             | Community — friction/gotcha logging workflow. |
| `voice-builder`        | `curated/voice-builder/`         | Community — voice/TTS persona construction. |
| `self-improving-agent` | `curated/self-improving-agent/`  | Community — preference memory & correction-loop pattern. |
| `obsidian-skills`      | `curated/obsidian-skills/`       | Community — Obsidian vault CLI, markdown, bases, canvas tooling. |

> **Attribution policy:** Curated skills retain their original authorship
> credit and license notices inside each skill directory. Modifications for
> hardening, portability, or runtime compatibility are documented per-skill.

---

## 🛠️ Development

- Each skill lives in its own directory with a `SKILL.md` entrypoint.
- Keep skills self-contained: no cross-skill imports, minimal external deps.
- Validate before committing:

```bash
bash -n install.sh                       # shell syntax check
find . -name 'SKILL.md' | sort           # inventory of skills
```

---

## 📄 License

**MIT License**

Copyright (c) 2026 benwiththelens

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*Curated community skills remain under their original licenses; see each
skill's directory for its specific attribution and license terms.*
