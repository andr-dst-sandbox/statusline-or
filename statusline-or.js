#!/usr/bin/env node
/*
 * statusline-or.js — custom Claude Code status line  (Windows-friendly, no Nerd Fonts)
 * ===================================================================================
 * Inspired by ccstatusline (https://github.com/sirmalloc/ccstatusline) but self-contained:
 * pure Node, block-character bars, ANSI colors, and its own cost engine.
 *
 * Line 1:  model · effort │ context bar │ cache hit% │ token count │ project dir
 * Line 2:  5h  bar % · reset · $cost  │  7d bar % · reset · $cost  │  OR≈ session $
 *
 * COSTS ("OR≈"): rough OpenRouter / API-equivalent dollars.
 *   - Session $  = Claude Code's own client-side estimate (cost.total_cost_usd), computed
 *                  at Anthropic API per-token rates. OpenRouter passes Claude's per-token
 *                  rates through (markup is on credit purchases, not inference), so this is
 *                  effectively the "if I'd used the API" cost.
 *   - 5h / 7d $  = summed from transcript token usage in the ~/.claude/projects JSONL files,
 *                  priced with the same per-token table (see PRICES). The window is aligned
 *                  to your rate-limit block (resets_at − 5h / − 7d) for subscribers, or a
 *                  rolling now−5h / now−7d window otherwise. Parsing is cached per file
 *                  (keyed by mtime+size) in ~/.claude/.statusline-or-cache.json so the 10s
 *                  refresh stays cheap after a one-time warm-up.
 *
 * All stdin fields are read defensively; absent/null ones just drop their segment.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CACHE_FILE = path.join(HOME, '.claude', '.statusline-or-cache.json');

// ---------------------------------------------------------------------------
// Cross-machine aggregation (opt-in via SL_SHARE_DIR).
// ---------------------------------------------------------------------------
// The 5h/7d $ are summed from local transcripts only, so on a multi-VM account
// each machine sees just its own slice (the % bars, by contrast, come from the
// account-wide rate_limits payload). Anthropic exposes no account-wide token/$
// figure to the status line — only a percentage — so the only way to get true
// account-wide DOLLARS is to pool transcripts across machines.
//
// Mechanism, fully self-contained (no cron/sync job): on each refresh this
// machine publishes a small, locally-deduped per-host summary of its last ~10
// days of usage to <shareDir>/by-host/<hostname>.json, and reads the OTHER
// hosts' summaries back. The windows then sum local + remote with the same
// global message.id dedup. Point the share dir at any folder visible on every
// machine (a synced OneDrive/Dropbox/Syncthing dir, or a UNC share).
//
// Configure the path WITHOUT editing this (public) file, via either:
//   - env SL_SHARE_DIR, or
//   - ~/.claude/statusline-or.local.json  =>  { "shareDir": "C:\\...\\cc-usage" }
// Neither set => behaves exactly as before (this machine only). The local-config
// route keeps per-machine paths out of version control.
function resolveShareDir() {
  if (process.env.SL_SHARE_DIR) return process.env.SL_SHARE_DIR;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'statusline-or.local.json'), 'utf8'));
    if (cfg && cfg.shareDir) return String(cfg.shareDir);
  } catch (_) {}
  return '';
}
const SHARE_DIR = resolveShareDir();
const HOSTNAME = String(os.hostname() || 'host').replace(/[^A-Za-z0-9._-]/g, '_');

// Manual pin for the Fable weekly usage bar. Claude Code's status-line payload
// carries NO per-model rate limit (only account-wide 5h/7d), so the real Fable
// weekly % lives only in `/usage`. Type it here to show it on the bar; it stays
// until you update it (re-read every refresh). Env wins over the local file.
//   - env SL_FABLE_PCT=65, or
//   - ~/.claude/statusline-or.local.json  =>  { "fablePct": 65 }
// Unset => the Fable bar falls back to live spend-share.
function resolveFablePct() {
  const e = process.env.SL_FABLE_PCT;
  if (e != null && e !== '') { const n = Number(e); if (isFinite(n)) return n; }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'statusline-or.local.json'), 'utf8'));
    if (cfg && cfg.fablePct != null) { const n = Number(cfg.fablePct); if (isFinite(n)) return n; }
  } catch (_) {}
  return null;
}
const FABLE_PCT = resolveFablePct();

// ---------------------------------------------------------------------------
// Pricing — USD per 1,000,000 tokens. Matches Anthropic list prices, which
// OpenRouter mirrors for Claude models. Edit here if rates change.
// ---------------------------------------------------------------------------
// USD per 1,000,000 tokens. Anthropic list prices (which OpenRouter mirrors as a
// pass-through for Claude models), verified 2026-07. cw = cache write (base/5-min,
// = 1.25x input), cr = cache read (= 0.1x input).
//   Fable 5:  $10 / $50     (claude-fable-5, and claude-mythos-5 — same pricing)
//   Opus 4.x: $5  / $25     (claude-opus-4-*)
//   Sonnet 5: $3  / $15     (claude-sonnet-5 / 4.6; intro $2/$10 through 2026-08-31 not applied)
//   Haiku:    $1  / $5      (claude-haiku-4-5)
const PRICES = {
  fable:  { in: 10.0, out: 50.0, cw: 12.5,  cr: 1.00 },
  opus:   { in: 5.0,  out: 25.0, cw: 6.25,  cr: 0.50 },
  sonnet: { in: 3.0,  out: 15.0, cw: 3.75,  cr: 0.30 },
  haiku:  { in: 1.0,  out: 5.0,  cw: 1.25,  cr: 0.10 },
};
function tierOf(model) {
  const id = String(model || '').toLowerCase();
  if (id.includes('fable') || id.includes('mythos')) return 'fable';
  if (id.includes('opus')) return 'opus';
  if (id.includes('haiku')) return 'haiku';
  return 'sonnet'; // sensible mid-tier default (sonnet 5/4.x and unknown ids)
}
function priceFor(model) { return PRICES[tierOf(model)]; }
function entryCost(model, u) {
  const p = priceFor(model);
  return (
    (u.input_tokens || 0) * p.in +
    (u.output_tokens || 0) * p.out +
    (u.cache_read_input_tokens || 0) * p.cr +
    (u.cache_creation_input_tokens || 0) * p.cw
  ) / 1e6;
}

// ---------------------------------------------------------------------------
// Colors — truecolor themes (Windows Terminal supports 24-bit color).
// Switch with one word below, or set env SL_THEME=tokyonight (etc).
// Tweak any single color by editing its hex in the active theme.
//   model=name  effort=·effort  label=ctx/5h/7d/tok  good/warn/bad=bar heat
//   cost=$  cache=⚡  tok=↑↓ counts  dim=resets/sub-text  track=empty bar  sep=│
// ---------------------------------------------------------------------------
const THEMES = {
  catppuccin: { model: '89dceb', effort: 'b4befe', label: 'a6adc8', track: '45475a', dim: '7f849c', good: 'a6e3a1', warn: 'fab387', bad: 'f38ba8', cost: 'f9e2af', cache: 'cba6f7', tok: '74c7ec', sep: '494d64' },
  tokyonight: { model: '7aa2f7', effort: '9d7cd8', label: 'a9b1d6', track: '3b4261', dim: '565f89', good: '9ece6a', warn: 'e0af68', bad: 'f7768e', cost: 'ffc777', cache: 'bb9af7', tok: '7dcfff', sep: '292e42' },
  gruvbox:    { model: '8ec07c', effort: '83a598', label: 'a89984', track: '504945', dim: '7c6f64', good: 'b8bb26', warn: 'fabd2f', bad: 'fb4934', cost: 'fe8019', cache: 'd3869b', tok: '83a598', sep: '3c3836' },
  nord:       { model: '88c0d0', effort: '81a1c1', label: 'd8dee9', track: '434c5e', dim: '616e88', good: 'a3be8c', warn: 'ebcb8b', bad: 'bf616a', cost: 'd08770', cache: 'b48ead', tok: '8fbcbb', sep: '3b4252' },
};
const ACTIVE_THEME = process.env.SL_THEME || 'catppuccin'; // catppuccin | tokyonight | gruvbox | nord
const THEME = THEMES[String(ACTIVE_THEME).toLowerCase().replace(/[^a-z]/g, '')] || THEMES.catppuccin;

const USE_COLOR = !process.env.NO_COLOR;
function rgb(h) { return `${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4, 6), 16)}`; }
function paint(h) { const t = rgb(h); return (s) => (USE_COLOR ? `\x1b[38;2;${t}m${s}\x1b[0m` : String(s)); }
const C = {
  model: paint(THEME.model), effort: paint(THEME.effort), label: paint(THEME.label),
  track: paint(THEME.track), good: paint(THEME.good), warn: paint(THEME.warn), bad: paint(THEME.bad),
  cost: paint(THEME.cost), cache: paint(THEME.cache), tok: paint(THEME.tok), dim: paint(THEME.dim),
};
const SEP = USE_COLOR ? `\x1b[38;2;${rgb(THEME.sep)}m │ \x1b[0m` : ' | ';

function heat(pct, warnAt, badAt) {
  if (pct >= badAt) return C.bad;
  if (pct >= warnAt) return C.warn;
  return C.good;
}
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// ---------------------------------------------------------------------------
// Progress bar (eighth-block resolution)
// ---------------------------------------------------------------------------
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
function bar(pct, width, warnAt, badAt) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const units = (p / 100) * width;
  let full = Math.floor(units);
  const pIdx = Math.round((units - full) * 8);
  let fill = '█'.repeat(Math.min(full, width));
  let used = Math.min(full, width);
  if (used < width && pIdx > 0) { fill += pIdx >= 8 ? '█' : PARTIAL[pIdx]; used++; }
  const track = '░'.repeat(Math.max(0, width - used));
  return heat(p, warnAt, badAt)(fill) + C.track(track);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}
function money(v) { return '$' + Number(v).toFixed(2); }

function untilReset(epochSec) {
  if (!epochSec || !isFinite(epochSec)) return '';
  let s = Math.round(epochSec - Date.now() / 1000);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 99) return '99d+';
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}
function clockHM(epochSec) {
  const d = new Date(epochSec * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtDuration(ms) {
  let s = Math.round((Number(ms) || 0) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// ---------------------------------------------------------------------------
// Transcript cost engine (incremental, cached)
// ---------------------------------------------------------------------------
function walkJsonl(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(fp, out);
    else if (e.name.endsWith('.jsonl')) {
      try { const s = fs.statSync(fp); out.push({ fp, mtime: s.mtimeMs, size: s.size }); } catch (_) {}
    }
  }
}
function parseFile(fp) {
  const msgs = [];                  // {k: dedupKey|null, h: epochHour, c: costUSD}
  const tok = { in: 0, out: 0, cr: 0, cw: 0 };
  const localSeen = new Set();
  // Resumed transcripts embed weeks of old history; only the last ~10 days can
  // ever fall inside a 7-day window, so cap stored records to keep the cache small.
  const minTs = Date.now() - 10 * 86400e3;
  let content;
  try { content = fs.readFileSync(fp, 'utf8'); } catch (_) { return { msgs, tok }; }
  for (const line of content.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    const u = o.message && o.message.usage;
    if (!u) continue;
    const id = o.message && o.message.id;
    const k = id ? id + ':' + (o.requestId || '') : null;
    if (k) { if (localSeen.has(k)) continue; localSeen.add(k); }
    const ts = Date.parse(o.timestamp);
    if (isNaN(ts)) continue;
    tok.in += u.input_tokens || 0;
    tok.out += u.output_tokens || 0;
    tok.cr += u.cache_read_input_tokens || 0;
    tok.cw += u.cache_creation_input_tokens || 0;
    if (ts < minTs) continue; // counted toward token totals, but too old for any window
    const model = o.message && o.message.model;
    msgs.push({ k, t: ts, c: entryCost(model, u), md: tierOf(model) }); // t = exact ms timestamp, md = model tier
  }
  return { msgs, tok };
}
const CACHE_VERSION = 4; // bump when the cached per-message record shape changes (v4 adds md = model tier)
function loadCache() {
  try { const o = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); if (o && o.files && o.version === CACHE_VERSION) return o; } catch (_) {}
  return { version: CACHE_VERSION, files: {} };
}
function computeWindows(data) {
  const now = Date.now();
  // Cost windows are ALIGNED to your rate-limit usage periods, so each $ matches its
  // % bar: 5h = the current 5-hour block; 7d = the current weekly window (e.g. Sat→Sat).
  // Window start = reset time − window length, taken from rate_limits.resets_at.
  // Falls back to a rolling now−5h / now−7d window when rate_limits is absent.
  const rl = data.rate_limits || {};
  const r5 = rl.five_hour && rl.five_hour.resets_at;
  const r7 = rl.seven_day && rl.seven_day.resets_at;
  const start5 = (r5 ? r5 * 1000 : now) - 5 * 3600e3;
  const start7 = (r7 ? r7 * 1000 : now) - 7 * 86400e3;
  const earliest = Math.min(start5, start7);

  // Far-future resets (e.g. the synthetic mock's sentinel) → window not open yet, no I/O.
  if (earliest > now) return { five: 0, week: 0, sessionTok: null };

  const files = [];
  walkJsonl(PROJECTS_DIR, files);
  if (!files.length) return { five: null, week: null, sessionTok: null };

  const recent = files.filter((f) => f.mtime >= earliest - 3600e3);
  const cache = loadCache();
  const keep = {};
  const transcript = data.transcript_path ? path.resolve(data.transcript_path) : null;
  let dirty = false;

  // (Re)parse only changed files; reuse cached per-message records otherwise.
  for (const f of recent) {
    let e = cache.files[f.fp];
    if (!e || e.mtime !== f.mtime || e.size !== f.size || !Array.isArray(e.msgs)) {
      const parsed = parseFile(f.fp);
      e = { mtime: f.mtime, size: f.size, msgs: parsed.msgs, tok: parsed.tok };
      dirty = true;
    }
    keep[f.fp] = e;
  }

  // Flatten this machine's records into one GLOBALLY-deduped list — resumed
  // sessions copy prior messages into new transcripts (~58% duplicate lines
  // here), so counting per-file double-bills. This list is also what we publish
  // for other machines, so it must already be deduped.
  const localSeen = new Set();
  const localMsgs = [];
  let sessionTok = null;
  for (const fp in keep) {
    const e = keep[fp];
    for (const m of e.msgs) {
      if (m.k) { if (localSeen.has(m.k)) continue; localSeen.add(m.k); }
      localMsgs.push(m);
    }
    if (transcript && path.resolve(fp) === transcript) sessionTok = e.tok;
  }

  // Prune cache to the recent set (older files can't re-enter the windows).
  if (!dirty && Object.keys(cache.files).length !== Object.keys(keep).length) dirty = true;
  if (dirty) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, files: keep })); } catch (_) {} }

  // Publish/consume per-host summaries for account-wide totals (opt-in).
  // Publish when local data changed (dirty) but at most once per PUBLISH_THROTTLE
  // (the summary is ~hundreds of KB and a synced folder shouldn't be rewritten on
  // every keystroke); always create it if missing. An idle machine never writes.
  const PUBLISH_THROTTLE = 90e3;
  const allMsgs = localMsgs.slice();
  if (SHARE_DIR) {
    const byHost = path.join(SHARE_DIR, 'by-host');
    const ownFile = HOSTNAME + '.json';
    const ownPath = path.join(byHost, ownFile);
    try {
      let publish = true;
      try { publish = dirty && (now - fs.statSync(ownPath).mtimeMs > PUBLISH_THROTTLE); }
      catch (_) { publish = true; } // missing summary => create it
      if (publish) {
        fs.mkdirSync(byHost, { recursive: true });
        const tmp = ownPath + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ host: HOSTNAME, updatedAt: now, msgs: localMsgs }));
        fs.renameSync(tmp, ownPath); // atomic swap
      }
    } catch (_) {}
    // Merge in every OTHER host's summary (our own slice is already in allMsgs).
    let ents = [];
    try { ents = fs.readdirSync(byHost); } catch (_) {}
    for (const fn of ents) {
      if (!fn.endsWith('.json') || fn === ownFile) continue;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(byHost, fn), 'utf8'));
        if (o && Array.isArray(o.msgs)) for (const m of o.msgs) allMsgs.push(m);
      } catch (_) {}
    }
  }

  // Sum windows with GLOBAL dedup across all hosts (message ids are unique, so
  // this only matters if a transcript was copied between machines by hand).
  // by5/by7: per-model-tier cost within each window (Anthropic sends no per-model
  // rate limit, so we attribute spend ourselves from each transcript's model id).
  const seen = new Set();
  let five = 0, week = 0;
  const by5 = {}, by7 = {};
  for (const m of allMsgs) {
    if (m.k) { if (seen.has(m.k)) continue; seen.add(m.k); }
    const md = m.md || 'other'; // remote summaries from a pre-v4 host lack md
    if (m.t >= start7) { week += m.c; by7[md] = (by7[md] || 0) + m.c; }
    if (m.t >= start5) { five += m.c; by5[md] = (by5[md] || 0) + m.c; }
  }

  return { five, week, sessionTok, by5, by7 };
}

// ---------------------------------------------------------------------------
// Segment builders
// ---------------------------------------------------------------------------
function baseName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
function contextSegment(data) {
  const cw = data.context_window || {};
  let pct = cw.used_percentage;
  const size = Number(cw.context_window_size) || 0;
  if (pct == null && cw.current_usage && size) {
    const u = cw.current_usage;
    const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
              (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    pct = (t / size) * 100;
  }
  if (pct == null) return `${C.label('ctx')} ${C.dim('--')}`;
  const used = size ? ` ${C.dim(fmtTokens((pct / 100) * size) + '/' + fmtTokens(size))}` : '';
  return `${C.label('ctx')} ${bar(pct, 10, 60, 85)} ${heat(pct, 60, 85)(Math.round(pct) + '%')}${used}`;
}
// Returns {in,out,cr,cw} for token/cache display: prefer cumulative session, else current turn.
function tokenSource(data, sessionTok) {
  if (sessionTok && (sessionTok.in || sessionTok.out || sessionTok.cr || sessionTok.cw)) return sessionTok;
  const u = data.context_window && data.context_window.current_usage;
  if (u) return { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 };
  return null;
}
function cacheSegment(src) {
  if (!src) return null;
  const inside = src.in + src.cr + src.cw;
  if (inside <= 0) return null;
  const hit = Math.round((src.cr / inside) * 100);
  return `${C.cache('⚡' + hit + '%')} ${C.dim('cache')}`;
}
function tokenSegment(src) {
  if (!src) return null;
  const inSide = src.in + src.cr + src.cw;
  return `${C.label('tok')} ${C.tok('↑' + fmtTokens(inSide))} ${C.tok('↓' + fmtTokens(src.out))}`;
}
function usageSegment(name, win, weekly) {
  if (!win || win.used_percentage == null) return null;
  const pct = Number(win.used_percentage);
  let reset = '';
  if (win.resets_at) {
    const u = untilReset(win.resets_at);
    if (u && u !== '99d+') reset = ` ${C.dim('↻' + u + '·' + (weekly ? WD[new Date(win.resets_at * 1000).getDay()] : clockHM(win.resets_at)))}`;
    else if (u) reset = ` ${C.dim('↻' + u)}`;
  }
  return `${C.label(name)} ${bar(pct, 10, 50, 80)} ${heat(pct, 50, 80)(Math.round(pct) + '%')}${reset}`;
}
// Grouped, clearly-labeled costs. The OR≈ header flags all three as OpenRouter/
// API-equivalent estimates. Scope: sess = this chat; 5h/7d = ALL Claude Code on
// this machine in the rate-limit window (other projects + subagents included).
function costGroup(win, sessionCost) {
  const parts = [];
  if (isFinite(sessionCost)) parts.push(`${C.dim('sess')} ${C.cost(money(sessionCost))}`);
  if (win.five != null) parts.push(`${C.dim('5h')} ${C.cost(money(win.five))}`);
  if (win.week != null) parts.push(`${C.dim('7d')} ${C.cost(money(win.week))}`);
  if (!parts.length) return null;
  return `${C.label('OR≈')} ` + parts.join(C.dim(' · '));
}
// Fable-only usage on line 3, with the live $ spent in the window alongside.
// If pinPct is set (the manual weekly-limit pin from /usage), the bar is a real
// usage meter: heat-colored (green/amber/red) and a ↻ marker to flag it's pinned.
// Otherwise the bar is fable's share of the window $ — a proportion, kept neutral
// (never warn/bad). Hidden when fable is unused and nothing is pinned.
function fableSegment(by, total, label, pinPct) {
  if (!by || !(total > 0)) return null;
  const c = by.fable || 0;
  if (c <= 0 && pinPct == null) return null;
  if (pinPct != null) {
    const p = Math.max(0, Math.min(100, pinPct));
    return `${C.label(label)} ${bar(p, 10, 50, 80)} ${heat(p, 50, 80)(Math.round(p) + '%')} ${C.dim('◈')} ${C.cost(money(c))}`;
  }
  const pct = (c / total) * 100;
  return `${C.label(label)} ${bar(pct, 10, 101, 101)} ${C.model(Math.round(pct) + '%')} ${C.cost(money(c))}`;
}

// Join segments to fit COLUMNS, dropping lowest-priority (last) optional ones first.
function fitLine(required, optional) {
  const cols = Number(process.env.COLUMNS) || 120;
  let segs = required.concat(optional).filter(Boolean);
  const len = (arr) => stripAnsi(arr.join(stripAnsi(SEP))).length;
  while (segs.length > required.length && len(segs) > cols) segs.pop();
  return segs.join(SEP);
}

// ---------------------------------------------------------------------------
function render(data) {
  let win = { five: null, week: null, sessionTok: null };
  try { win = computeWindows(data); } catch (_) {}

  // ---- line 1 ----
  const name = (data.model && (data.model.display_name || data.model.id)) || 'model';
  let ident = C.model(name);
  if (data.effort && data.effort.level) ident += ' ' + C.effort('·' + data.effort.level);

  const src = tokenSource(data, win.sessionTok);
  const dir = baseName((data.workspace && (data.workspace.current_dir || data.workspace.project_dir)));

  const line1 = fitLine(
    [ident, contextSegment(data)],
    [cacheSegment(src), tokenSegment(src), dir ? C.label('▸ ') + dir : null]
  );

  // ---- line 2: usage bars (5h | 7d, with resets), then grouped costs (sess | 5h | 7d) ----
  const rl = data.rate_limits || {};
  const five = usageSegment('5h', rl.five_hour, false);
  const seven = usageSegment('7d', rl.seven_day, true);
  const sessionCost = Number(data.cost && data.cost.total_cost_usd);
  const costs = costGroup(win, sessionCost);
  const bars = [five, seven].filter(Boolean).join(SEP);
  const cols = Number(process.env.COLUMNS) || 120;

  // Bars + costs on one line when it fits; otherwise costs wrap to their own line.
  const lines = [line1];
  if (bars && costs) {
    const oneLine = bars + SEP + costs;
    if (stripAnsi(oneLine).length <= cols) lines.push(oneLine);
    else { lines.push(bars); lines.push(costs); }
  } else {
    lines.push(bars || costs || C.dim('no usage data'));
  }

  // ---- line 3: fable-only bar (SL_FABLE=0 disables; =5h uses the 5h window, default 7d) ----
  // The manual pin (FABLE_PCT) is a weekly figure, so it applies only to the 7d view.
  if (process.env.SL_FABLE !== '0') {
    const use5 = process.env.SL_FABLE === '5h';
    const fb = fableSegment(
      use5 ? win.by5 : win.by7,
      use5 ? win.five : win.week,
      use5 ? '5h fable' : '7d fable',
      use5 ? null : FABLE_PCT
    );
    if (fb) lines.push(fb);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(buf || '{}'); } catch (_) {}
  try { process.stdout.write(render(data) + '\n'); }
  catch (e) { process.stdout.write(((data.model && data.model.display_name) || 'Claude') + '\n'); }
});
