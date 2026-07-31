---
name: server-ops
description: Portable Linux/Docker host health monitoring — container status, CPU temperature, RAM usage, and disk space in one zero-dependency CLI.
author: "Ben Weber (@benwiththelens) & VANTAGE"
license: MIT
---

# Server Ops

A plug-and-play, zero-dependency Node.js utility for monitoring any Linux/Docker
host. Drop `server_ops.mjs` onto a machine and instantly get container status,
CPU thermals, memory pressure, and disk capacity — no packages to install, no
config files required.

## Requirements

- Node.js 18+
- Standard Linux userspace: `docker` (optional, for container commands),
  `free`, `df`, and `/sys/class/thermal/*` (present on virtually all Linux hosts)
- No npm dependencies. No root required for read-only commands.

## Usage

```bash
node server_ops.mjs <command>
```

| Command  | What it reports |
| -------- | --------------- |
| `ps`     | Docker container status (name, state, uptime, ports) |
| `stats`  | Live per-container CPU % and memory usage |
| `temp`   | CPU/SoC temperature from Linux thermal zones (°C) |
| `mem`    | RAM and swap usage via `free -m` |
| `disk`   | Filesystem capacity via `df -h` (auto-filters pseudo-filesystems) |
| `health` | All of the above in a single consolidated report |

## Examples

```bash
# Full one-shot health report (ideal for agent ingestion — compact by design)
node server_ops.mjs health

# Just check thermals before a heavy job
node server_ops.mjs temp

# Are my containers alive?
node server_ops.mjs ps
```

## Agent Integration Guidance

1. **Diagnose before acting.** If a service misbehaves, run `health` or `ps`
   first — never blind-restart infrastructure.
2. **Output is pre-compressed.** All commands emit short, formatted tables
   safe for direct LLM context ingestion. Do not wrap them in additional
   raw log dumps.
3. **Graceful degradation.** If Docker isn't installed or the daemon isn't
   reachable, container commands report the error cleanly instead of crashing;
   host-level commands (`temp`, `mem`, `disk`) work on any Linux box,
   containerized or bare metal.

---
*Portability: any Linux host · Docker optional · zero npm dependencies*
