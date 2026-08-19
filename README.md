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

## 🚀 Featured: Autonomous Jules Pipeline v2+

The `jules-dispatch` skill provides a complete, event-driven development
architecture for [Google Jules](https://jules.google.com). Key capabilities:

- **Graphify AST Code Intelligence:** Automatically queries TypeScript AST indexes and injects exact symbols, type exports, and file dependencies into prompts.
- **Queue Dispatcher & Quota Governor:** Enforces daily safety caps (80/100) with a 20-session manual reserve, priority ordering (`critical → high → medium → low`), and `depends_on` prerequisite gating.
- **Autonomous Feedback Resolution:** When Jules pauses for user input or plan approvals, an automated subagent inspects the git patch and resolves blockers via a resilient model fallback chain (`gemini-3.5-flash-lite` → `kimi-k3`).
- **Summary-State Polling Optimization:** The notifier checks summary state flags to skip redundant API calls for terminal sessions, minimizing latency and quota usage.
- **Multi-Model Audit & Merge Gatekeeper:** 3-phase automated gatekeeper with high-reasoning security audits, blast-radius human review triggers (CI/CD, secrets, auth), automatic lockfile conflict healing, full monorepo test enforcement (`npm test`), auto-merging, and rollback tagging.
- **Unified State Engine & Rolling Compaction:** Atomic state updates, sub-50KB active state footprint, and monthly history archiving.

See [`original/jules-dispatch/DESIGN_SPEC.md`](original/jules-dispatch/DESIGN_SPEC.md)
for the full architecture specification.

---

## 📦 Repository Layout

```
agent-skills/
├── original/        # Skills authored from scratch by benwiththelens
│   ├── jules-dispatch/
│   │   ├── SKILL.md                 # Entrypoint documentation
│   │   ├── DESIGN_SPEC.md            # Comprehensive architecture specification
│   │   ├── jules_dispatcher.mjs      # Queue dispatcher & AST enricher
│   │   ├── jules_notifier.mjs        # Session monitor & feedback orchestrator
│   │   ├── jules_merge_gatekeeper.mjs# LLM security audit, test runner & auto-merge
│   │   ├── jules_state_manager.mjs   # Atomic state engine & rolling compaction
│   │   ├── jules_client.mjs          # Zero-dependency Google Jules API client
│   │   ├── jules_discord.mjs         # Shared Discord alerting transport
│   │   └── jules_gate.mjs            # Dormant trigger gate (superseded by notifier)
│   ├── server-ops/
│   └── catalyst-ingest/
├── curated/         # Community skills, reviewed & hardened
│   ├── papercuts/
│   ├── voice-builder/
│   ├── self-improving-agent/
│   └── obsidian-skills/
├── scripts/         # Maintenance / sync / validation tooling
├── install.sh       # One-shot installer (symlink or copy)
└── README.md        # Master repository index
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
| `jules-dispatch`  | `original/jules-dispatch/`  | Autonomous Jules Pipeline v2+ — queue dispatcher with Graphify AST, quota governor, subagent feedback orchestrator, rolling state compaction, and multi-model audit & merge gatekeeping. |
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
