#!/usr/bin/env node
/**
 * server_ops.mjs
 * ----------------
 * Plug-and-play Linux & Docker host monitoring — zero npm dependencies.
 *
 * Commands:
 *   ps      Docker container status (name, state, uptime, ports)
 *   stats   Live per-container CPU % and memory usage
 *   temp    CPU/SoC temperature from Linux thermal zones (°C)
 *   mem     RAM and swap usage (via `free`, /proc/meminfo fallback)
 *   disk    Filesystem capacity via `df -h` (pseudo-filesystems filtered)
 *   health  All of the above in one consolidated report
 *
 * Environment variable overrides:
 *   SERVER_OPS_DOCKER_BIN    Path/name of docker binary        (default: "docker")
 *   SERVER_OPS_DISK_PATHS    Comma-separated mount filter for `disk`
 *                            e.g. "/,/mnt/storage"            (default: all real fs)
 *   SERVER_OPS_TEMP_ZONES    Comma-separated thermal zone globs
 *                            e.g. "0,1" or "x86_pkg_temp"     (default: all zones)
 *   SERVER_OPS_MEM_TOTAL_MB  Override total RAM in MB (useful inside containers
 *                            where `free` reports the host's memory)
 *   SERVER_OPS_NO_DOCKER=1   Skip all Docker commands entirely
 *
 * No root required for read-only commands. Docker commands degrade cleanly
 * if the daemon is unreachable. Works on bare metal, VMs, and inside
 * unprivileged containers.
 *
 * License: MIT
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const DOCKER_BIN = process.env.SERVER_OPS_DOCKER_BIN || 'docker';
const NO_DOCKER = process.env.SERVER_OPS_NO_DOCKER === '1';
const DISK_PATHS = (process.env.SERVER_OPS_DISK_PATHS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TEMP_ZONES = (process.env.SERVER_OPS_TEMP_ZONES || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const MEM_TOTAL_MB_OVERRIDE = parseInt(process.env.SERVER_OPS_MEM_TOTAL_MB || '', 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a command, return trimmed stdout or null on failure. Never throws. */
function tryExec(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/** True if the docker daemon answers. Cached per-process. */
let dockerChecked = null;
function dockerAvailable() {
  if (NO_DOCKER) return false;
  if (dockerChecked !== null) return dockerChecked;
  dockerChecked = tryExec(DOCKER_BIN, ['info', '--format', '{{.ServerVersion}}']) !== null;
  return dockerChecked;
}

function header(title) {
  const line = '─'.repeat(Math.max(0, 52 - title.length));
  console.log(`\n● ${title} ${line}`);
}

// ---------------------------------------------------------------------------
// Command: ps — Docker container status
// ---------------------------------------------------------------------------
function cmdPs() {
  header('Docker Containers');
  if (!dockerAvailable()) {
    console.log('  (docker unavailable or daemon unreachable)');
    return false;
  }
  const out = tryExec(DOCKER_BIN, [
    'ps', '-a',
    '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'
  ]);
  if (!out) {
    console.log('  (no containers)');
    return true;
  }
  console.log('  NAME                          STATUS                          PORTS');
  console.log('  ' + '─'.repeat(78));
  for (const line of out.split('\n')) {
    const [name = '', status = '', ports = ''] = line.split('\t');
    const state = status.toLowerCase().startsWith('up') ? '✓' : '✗';
    console.log(`  ${state} ${name.padEnd(28)}${status.padEnd(32)}${ports || '—'}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command: stats — live per-container CPU/mem
// ---------------------------------------------------------------------------
function cmdStats() {
  header('Container Resources (live sample)');
  if (!dockerAvailable()) {
    console.log('  (docker unavailable or daemon unreachable)');
    return false;
  }
  const out = tryExec(DOCKER_BIN, [
    'stats', '--no-stream',
    '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'
  ]);
  if (!out) {
    console.log('  (no running containers)');
    return true;
  }
  console.log('  NAME                          CPU %       MEMORY                  MEM %');
  console.log('  ' + '─'.repeat(78));
  for (const line of out.split('\n')) {
    const [name = '', cpu = '', mem = '', memPct = ''] = line.split('\t');
    console.log(`  ${name.padEnd(30)}${cpu.padEnd(12)}${mem.padEnd(24)}${memPct}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command: temp — CPU/SoC temperature from thermal zones
// ---------------------------------------------------------------------------
function cmdTemp() {
  header('CPU / SoC Temperature');
  let zones;
  try {
    zones = readdirSync('/sys/class/thermal').filter(d => d.startsWith('thermal_zone'));
  } catch {
    console.log('  (no thermal zones exposed — /sys/class/thermal not readable)');
    return false;
  }
  if (zones.length === 0) {
    console.log('  (no thermal zones found)');
    return false;
  }

  let reported = 0;
  for (const zone of zones.sort()) {
    const base = `/sys/class/thermal/${zone}`;
    let type = 'unknown';
    let raw = null;
    try { type = readFileSync(`${base}/type`, 'utf8').trim(); } catch { /* keep default */ }
    try { raw = readFileSync(`${base}/temp`, 'utf8').trim(); } catch { continue; }

    // Apply zone filter if provided (matches zone index or type substring)
    if (TEMP_ZONES.length > 0) {
      const idx = zone.replace('thermal_zone', '');
      const hit = TEMP_ZONES.some(f =>
        f === idx || type.toLowerCase().includes(f.toLowerCase()));
      if (!hit) continue;
    }

    const milli = parseInt(raw, 10);
    if (Number.isNaN(milli)) continue;
    const celsius = milli / 1000;
    const flag = celsius >= 80 ? ' 🔥 HOT' : celsius >= 65 ? ' ⚠ warm' : '';
    console.log(`  ${type.padEnd(28)} ${celsius.toFixed(1)} °C${flag}`);
    reported++;
  }
  if (reported === 0) console.log('  (thermal zones present but unreadable)');
  return reported > 0;
}

// ---------------------------------------------------------------------------
// Command: mem — RAM and swap usage
// ---------------------------------------------------------------------------
function readMeminfo() {
  // Returns { totalMB, usedMB, availMB, swapTotalMB, swapUsedMB } or null.
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
    };
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    const swapTotal = get('SwapTotal');
    const swapFree = get('SwapFree');
    if (total === null || avail === null) return null;
    return {
      totalMB: total,
      usedMB: total - avail,
      availMB: avail,
      swapTotalMB: swapTotal ?? 0,
      swapUsedMB: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : 0
    };
  } catch {
    return null;
  }
}

function cmdMem() {
  header('Memory');
  const info = readMeminfo();
  if (!info) {
    console.log('  (/proc/meminfo not readable)');
    return false;
  }
  const totalMB = Number.isInteger(MEM_TOTAL_MB_OVERRIDE) && MEM_TOTAL_MB_OVERRIDE > 0
    ? MEM_TOTAL_MB_OVERRIDE
    : info.totalMB;
  // Scale usage proportionally if total was overridden (container on shared host)
  const usedMB = totalMB === info.totalMB
    ? info.usedMB
    : Math.round(info.usedMB * (totalMB / info.totalMB));
  const pct = ((usedMB / totalMB) * 100).toFixed(1);
  const flag = pct >= 90 ? ' 🔥 CRITICAL' : pct >= 75 ? ' ⚠ high' : '';

  console.log(`  RAM:   ${usedMB} MB / ${totalMB} MB used (${pct}%)${flag}`);
  if (info.swapTotalMB > 0) {
    const swapPct = ((info.swapUsedMB / info.swapTotalMB) * 100).toFixed(1);
    console.log(`  Swap:  ${info.swapUsedMB} MB / ${info.swapTotalMB} MB used (${swapPct}%)`);
  } else {
    console.log('  Swap:  none configured');
  }
  if (totalMB !== info.totalMB) {
    console.log(`  (total overridden via SERVER_OPS_MEM_TOTAL_MB; kernel reports ${info.totalMB} MB)`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command: disk — filesystem capacity
// ---------------------------------------------------------------------------
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'ramfs', 'aufs',
  'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'mqueue', 'shm',
  'securityfs', 'debugfs', 'tracefs', 'configfs', 'fusectl', 'pstore',
  'bpf', 'hugetlbfs', 'nsfs', 'autofs', 'binfmt_misc', 'efivarfs'
]);

function cmdDisk() {
  header('Disk Usage');
  // -P = POSIX output (stable columns), -h handled manually for portability
  const out = tryExec('df', ['-P', '-B1M']);
  if (!out) {
    console.log('  (df unavailable)');
    return false;
  }
  const rows = out.split('\n').slice(1)
    .map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const [fs, size, used, avail, pct, ...mountParts] = parts;
      return { fs, size: +size, used: +used, avail: +avail, pct, mount: mountParts.join(' ') };
    })
    .filter(r => r && !PSEUDO_FS.has(r.fs) && !r.fs.startsWith('/dev/loop') && r.size > 0);

  const filtered = DISK_PATHS.length > 0
    ? rows.filter(r => DISK_PATHS.some(p => r.mount === p || r.mount.startsWith(p.endsWith('/') ? p : p + '/')))
    : rows;

  if (filtered.length === 0) {
    console.log('  (no matching filesystems)');
    return true;
  }

  console.log('  MOUNT                       SIZE        USED        AVAIL       USE%');
  console.log('  ' + '─'.repeat(78));
  for (const r of filtered) {
    const pctNum = parseInt(r.pct, 10);
    const flag = pctNum >= 90 ? ' 🔥' : pctNum >= 75 ? ' ⚠' : '';
    const fmt = (mb) => mb >= 1024 * 1024
      ? `${(mb / 1024 / 1024).toFixed(1)}T`
      : mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`;
    console.log(`  ${r.mount.padEnd(28)}${fmt(r.size).padEnd(12)}${fmt(r.used).padEnd(12)}${fmt(r.avail).padEnd(12)}${r.pct}${flag}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command: health — consolidated report
// ---------------------------------------------------------------------------
function cmdHealth() {
  console.log('═'.repeat(80));
  console.log(`  SERVER HEALTH REPORT — ${new Date().toISOString()}`);
  try {
    console.log(`  Host: ${readFileSync('/proc/sys/kernel/hostname', 'utf8').trim()}`);
  } catch { /* non-fatal */ }
  console.log('═'.repeat(80));
  cmdTemp();
  cmdMem();
  cmdDisk();
  cmdPs();
  cmdStats();
  console.log('');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const COMMANDS = {
  ps: cmdPs,
  stats: cmdStats,
  temp: cmdTemp,
  mem: cmdMem,
  disk: cmdDisk,
  health: cmdHealth
};

const cmd = (process.argv[2] || 'health').toLowerCase();

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`Usage: node server_ops.mjs [${Object.keys(COMMANDS).join('|')}]  (default: health)

Environment overrides:
  SERVER_OPS_DOCKER_BIN    docker binary path/name (default: docker)
  SERVER_OPS_DISK_PATHS    comma-separated mounts to include, e.g. /,/mnt/storage
  SERVER_OPS_TEMP_ZONES    comma-separated zone filter, e.g. 0,1 or x86_pkg_temp
  SERVER_OPS_MEM_TOTAL_MB  override total RAM (container on shared host)
  SERVER_OPS_NO_DOCKER=1   disable all Docker commands`);
  process.exit(0);
}

if (!COMMANDS[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Available: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

try {
  COMMANDS[cmd]();
} catch (err) {
  console.error(`server_ops '${cmd}' failed: ${err.message}`);
  process.exit(1);
}
