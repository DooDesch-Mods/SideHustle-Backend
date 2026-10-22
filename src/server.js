// Side Hustle backend - a public lobby directory + mod-manifest cache for the Schedule I co-op mod.
//
// Why this exists: the mod used to carry the host's mod manifest inside Steam lobby metadata (chunked lobby data).
// Steam's lobby-list snapshot drops large values and even RequestLobbyData is unreliable at ~30 mods, so joiners
// saw "Sync unavailable". This service carries the manifest + the discovery metadata over plain HTTP instead.
//
// What it is NOT: it does not do the multiplayer connection. Steam (FishySteamworks P2P) still connects the players;
// the Steam lobby id remains the join handle. This is only the metadata/discovery layer.
//
// Trust model (no Steam publisher key needed): the backend is an UNTRUSTED public cache. The host also writes a tiny
// `mhash` (manifest hash) onto the real Steam lobby, which Steam authenticates to the lobby owner and which always
// fits. A joiner fetches the full manifest here, hashes it, and only trusts it if that hash equals the Steam-lobby
// `mhash` AND GetLobbyOwner(lobbyId) matches the claimed host. A forged manifest can't match the real owner's
// Steam-written mhash. A per-session `secret` gates edits/removal so one client can't hijack another's listing.

import express from "express";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResolver, nexusSearchUrl } from "./resolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
const LOBBY_TTL_MS = parseInt(process.env.LOBBY_TTL_MS || "90000", 10); // expire a lobby ~90s after its last heartbeat
const SWEEP_MS = 30000;
const MAX_LOBBIES = parseInt(process.env.MAX_LOBBIES || "2000", 10);
const MAX_MANIFEST = parseInt(process.env.MAX_MANIFEST || "524288", 10); // 512 KB per payload - very generous
const PLAYS_FILE = process.env.PLAYS_FILE || "/data/plays.json";
const PLAYS_PER_IP_HOUR = parseInt(process.env.PLAYS_PER_IP_HOUR || "12", 10);
const PLAYS_KEEP_DAYS = 30; // also the largest window GET /api/plays serves
const PLAYS_MAX_GAMEMODES_PER_DAY = 200;
const PLAYS_WRITE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/** @type {Map<string, any>} lobbyId -> record */
const lobbies = new Map();

// ---- helpers ----------------------------------------------------------------

const str = (v, max = 128) => (typeof v === "string" ? v.slice(0, max) : "");
const idStr = (v) => (typeof v === "string" && /^[0-9]{1,20}$/.test(v) ? v : "");
const bool = (v) => v === true || v === "1" || v === 1;
const clampNum = (v, def, min, max) => {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
};

function publicView(l) {
  // The list view: everything a browser card needs, but NOT the big manifest/prefs payloads.
  return {
    lobbyId: l.lobbyId,
    ownerSteamId: l.ownerSteamId,
    hostName: l.hostName,
    lobbyName: l.lobbyName,
    kind: l.kind,
    gamemode: l.gamemode,
    gamemodeName: l.gamemodeName,
    enforce: l.enforce,
    maxPlayers: l.maxPlayers,
    members: l.members,
    hasPassword: l.hasPassword,
    modSummary: l.modSummary,
    gameVersion: l.gameVersion,
    appBuild: l.appBuild,
    mhash: l.mhash,
    updatedAt: l.updatedAt,
  };
}

function sweep() {
  const now = Date.now();
  for (const [id, l] of lobbies) if (l.expiresAt <= now) lobbies.delete(id);
  sweepPlayIps(now);
}
setInterval(sweep, SWEEP_MS).unref?.();

// A short-lived snapshot of the sorted public list. The public website polls the directory from every open tab;
// building the whole list per request would let viewer traffic compete with the game clients that publish and read
// manifests on this same process. Rebuilding at most every SNAPSHOT_MS coalesces a refresh storm into a bounded cost.
const SNAPSHOT_MS = parseInt(process.env.SNAPSHOT_MS || "2000", 10);
let snapshot = { at: 0, rows: [] };
function lobbySnapshot() {
  const now = Date.now();
  if (now - snapshot.at <= SNAPSHOT_MS) return snapshot.rows;
  sweep();
  const rows = [];
  // A friends-only lobby is published too, because its friends may need the manifest fallback to sync, but the host
  // chose not to be found by strangers, so it never reaches the public list. A mod without the field counts as public.
  for (const l of lobbies.values()) if (l.visibility !== "private") rows.push(publicView(l));
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  snapshot = { at: now, rows };
  return rows;
}

// ---- play counter -------------------------------------------------------------------------------------------------
// Anonymous counts of started gamemode sessions, one number per UTC day per gamemode id. No player or lobby identity
// is stored; the client IP only lives in memory for the hourly rate limit.

const GAMEMODE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @type {Record<string, Record<string, number>>} "YYYY-MM-DD" -> gamemode id -> plays */
let plays = {};
let playsDirty = false;
let playsWriteWarned = false;
/** @type {Map<string, number[]>} client ip -> timestamps of its accepted plays in the last hour */
const playIps = new Map();

function sweepPlayIps(now) {
  const cutoff = now - HOUR_MS;
  for (const [ip, times] of playIps) {
    const recent = times.filter((t) => t > cutoff);
    if (recent.length) playIps.set(ip, recent);
    else playIps.delete(ip);
  }
}

// Keep the last PLAYS_KEEP_DAYS UTC days including today; day keys sort as strings.
function prunePlays() {
  const oldest = utcDay(Date.now() - (PLAYS_KEEP_DAYS - 1) * DAY_MS);
  for (const day of Object.keys(plays)) if (day < oldest) delete plays[day];
}

// Only well-formed days and gamemode ids with positive integer counts survive a load.
function cleanPlays(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("top level is not an object");
  const out = {};
  for (const [day, modes] of Object.entries(data)) {
    if (!DAY_RE.test(day) || !modes || typeof modes !== "object" || Array.isArray(modes)) continue;
    const row = {};
    for (const [id, n] of Object.entries(modes)) {
      if (GAMEMODE_RE.test(id) && Number.isInteger(n) && n > 0) row[id.toLowerCase()] = n;
    }
    out[day] = row;
  }
  return out;
}

function warnPlaysUnwritable(reason) {
  if (playsWriteWarned) return;
  playsWriteWarned = true;
  console.warn(`[plays] cannot write ${PLAYS_FILE} (${reason}); counting in memory only until a write succeeds`);
}

function loadPlays() {
  let text;
  try {
    text = fs.readFileSync(PLAYS_FILE, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") console.log(`[plays] no ${PLAYS_FILE} yet, starting empty`);
    else console.error(`[plays] cannot read ${PLAYS_FILE} (${e.message}); starting empty`);
    return;
  }
  try {
    plays = cleanPlays(JSON.parse(text));
    prunePlays();
    console.log(`[plays] loaded ${Object.keys(plays).length} days from ${PLAYS_FILE}`);
  } catch (e) {
    console.error(`[plays] ${PLAYS_FILE} is corrupt (${e.message}); starting empty`);
    // Keep the broken file for inspection; the next save overwrites the original name.
    const bad = `${PLAYS_FILE}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.copyFileSync(PLAYS_FILE, bad);
      console.error(`[plays] kept the corrupt file as ${bad}`);
    } catch (e2) {
      console.error(`[plays] could not keep a copy of the corrupt file (${e2.message})`);
    }
  }
}

// Atomic write: a crash mid-write leaves the previous file intact instead of a truncated one.
function savePlays() {
  if (!playsDirty) return;
  prunePlays();
  const tmp = PLAYS_FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(plays));
    fs.renameSync(tmp, PLAYS_FILE);
    playsDirty = false;
    if (playsWriteWarned) {
      playsWriteWarned = false;
      console.log(`[plays] ${PLAYS_FILE} is writable again`);
    }
  } catch (e) {
    warnPlaysUnwritable(e.message);
  }
}

// Probe the directory at start so an unmounted or read-only /data shows up in the boot log, not 60 s later.
function checkPlaysDir() {
  const dir = path.dirname(PLAYS_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    warnPlaysUnwritable(e.message);
  }
}

// Returns null when counted, else the 429 error text. Rejected plays do not use up the caller's hourly budget.
function countPlay(ip, gamemode, now) {
  const recent = (playIps.get(ip) || []).filter((t) => t > now - HOUR_MS);
  if (recent.length >= PLAYS_PER_IP_HOUR) return "too many plays";
  const day = utcDay(now);
  const row = plays[day] || (plays[day] = {});
  if (!(gamemode in row) && Object.keys(row).length >= PLAYS_MAX_GAMEMODES_PER_DAY) return "too many gamemodes today";
  row[gamemode] = (row[gamemode] || 0) + 1;
  recent.push(now);
  playIps.set(ip, recent);
  playsDirty = true;
  return null;
}

function playsRanking(days) {
  const now = Date.now();
  const sums = new Map();
  for (let i = 0; i < days; i++) {
    const row = plays[utcDay(now - i * DAY_MS)];
    if (!row) continue;
    for (const [id, n] of Object.entries(row)) sums.set(id, (sums.get(id) || 0) + n);
  }
  return [...sums]
    .map(([gamemode, n]) => ({ gamemode, plays: n }))
    .sort((a, b) => b.plays - a.plays || (a.gamemode < b.gamemode ? -1 : a.gamemode > b.gamemode ? 1 : 0));
}

loadPlays();
checkPlaysDir();
setInterval(savePlays, PLAYS_WRITE_MS).unref?.();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[plays] ${sig}: saving before exit`);
    savePlays();
    process.exit(0);
  });
}

// ---- manifest -> structured mod list (powers the website's per-lobby "view mods" modal) --------------------------

// Mirror SyncManifest.Unesc (C# order: %0A, %0D, %7C, then %25 last so inserted escapes are not re-decoded).
function unescField(s) {
  if (!s) return "";
  return s.replace(/%0A/g, "\n").replace(/%0D/g, "\r").replace(/%7C/g, "|").replace(/%25/g, "%");
}

// Same allowlist the game uses (DownloadLink.IsAllowed): https + exact host or subdomain. The backend is an untrusted
// public cache, so an nx: Source could be anything - a non-allowlisted or non-https URL must never become a live href.
const NX_ALLOWED_HOSTS = ["thunderstore.io", "nexusmods.com", "github.com", "doodesch.de"];
function isAllowedNxUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return NX_ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

const nexusSearch = nexusSearchUrl;

// ts:{FullName}-{ver} -> Thunderstore package page. Version = text after the LAST '-' but only if it starts with a
// digit and contains '.' (mirrors the game's dependency split); FullName may itself contain hyphens. namespace =
// FullName up to the FIRST '-' (namespaces never contain '-'), name = the remainder.
function thunderstoreUrl(spec, fallbackName) {
  let fullName = spec;
  const lastDash = spec.lastIndexOf("-");
  if (lastDash > 0) {
    const ver = spec.slice(lastDash + 1);
    if (/^[0-9]/.test(ver) && ver.includes(".")) fullName = spec.slice(0, lastDash);
  }
  const firstDash = fullName.indexOf("-");
  if (firstDash > 0 && firstDash < fullName.length - 1) {
    const ns = fullName.slice(0, firstDash);
    const name = fullName.slice(firstDash + 1);
    return "https://thunderstore.io/c/schedule-i/p/" + encodeURIComponent(ns) + "/" + encodeURIComponent(name) + "/";
  }
  // couldn't split namespace/name -> community search, never a broken /p// link
  return "https://thunderstore.io/c/schedule-i/?search=" + encodeURIComponent(fullName || fallbackName || "");
}

// Which site an allowlisted link points to, for the label on the website.
function linkKind(u) {
  const host = new URL(u).hostname.toLowerCase();
  if (host === "nexusmods.com" || host.endsWith(".nexusmods.com")) return "nexus";
  if (host === "thunderstore.io" || host.endsWith(".thunderstore.io")) return "thunderstore";
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  return "link";
}

// found: "host" = the host's own manifest named the source; the resolver adds "verified", "version" and "name".
function resolveSource(source, name, file) {
  const searchName = name || (file || "").replace(/\.dll$/i, "");
  if (source && source.startsWith("ts:")) return { resolution: "thunderstore", url: thunderstoreUrl(source.slice(3), searchName), found: "host" };
  if (source && source.startsWith("nx:")) {
    const u = source.slice(3);
    if (isAllowedNxUrl(u)) return { resolution: linkKind(u), url: u, found: "host" };
    return { resolution: "search", url: nexusSearch(searchName), found: "none" }; // untrusted/garbage source -> safe Nexus search
  }
  return { resolution: "search", url: nexusSearch(searchName), found: "none" }; // "" = dropped: the resolver may still find it
}

// Parse the raw canonical manifest text into structured rows. Never throws (a malformed manifest -> []).
function parseManifestMods(text) {
  const out = [];
  if (typeof text !== "string" || text.length === 0) return out;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("m=")) continue;
    const parts = line.slice(2).split("|");
    if (parts.length !== 5) continue;
    const file = unescField(parts[0]);
    const name = unescField(parts[1]);
    const version = unescField(parts[2]);
    const sha256 = unescField(parts[3]);
    const source = unescField(parts[4]);
    const { resolution, url, found } = resolveSource(source, name, file);
    out.push({ file, name, version, sha256, source, resolution, url, found });
  }
  return out;
}

// ---- app --------------------------------------------------------------------

const resolver = createResolver();

// How long a request waits for the resolver before it answers with what it has. A lookup that is still running
// keeps going and lands in the cache, so the next request gets it.
const MODS_BUDGET_MS = parseInt(process.env.MODS_BUDGET_MS || "4000", 10);
const RESOLVE_BUDGET_MS = parseInt(process.env.RESOLVE_BUDGET_MS || "12000", 10);
const MAX_RESOLVE_ROWS = 64;

const within = (ms, p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms).unref?.())]);

// Rows the host could not source get a resolver answer; rows the host did source keep theirs.
async function withResolved(mods, budgetMs) {
  const open = mods.filter((m) => m.found === "none");
  if (!open.length) return mods;
  const answers = await within(budgetMs, Promise.all(open.map((m) => resolver.resolve(m))));
  for (let i = 0; i < open.length; i++) {
    const r = answers ? answers[i] : resolver.cached(open[i]);
    if (!r) { open[i].pending = true; continue; }
    if (r.resolution === "search") continue;
    Object.assign(open[i], { resolution: r.resolution, url: r.url, found: r.confidence, resolvedSource: r.source || "" });
  }
  return mods;
}

const app = express();
app.disable("x-powered-by");
// Dokploy's Traefik sits in front; trusting one hop makes req.ip the real client for the play rate limit.
app.set("trust proxy", 1);
app.use(express.json({ limit: MAX_MANIFEST + 4096 }));

app.get("/health", (_req, res) => res.json({ ok: true, lobbies: lobbies.size, plays: Object.keys(plays).length }));

// Count one started session of a gamemode. Body: { gamemode, mode: "host" | "solo" }. Hot path: no per-request log.
app.post("/api/plays", (req, res) => {
  const b = req.body || {};
  const gamemode = typeof b.gamemode === "string" && GAMEMODE_RE.test(b.gamemode) ? b.gamemode.toLowerCase() : "";
  if (!gamemode) return res.status(400).json({ ok: false, error: "gamemode must be a 1-64 char id (a-z, 0-9, . _ -)" });
  if (b.mode !== "host" && b.mode !== "solo") return res.status(400).json({ ok: false, error: "mode must be host or solo" });
  const error = countPlay(req.ip || "", gamemode, Date.now());
  if (error) return res.status(429).json({ ok: false, error });
  res.json({ ok: true });
});

// Plays per gamemode summed over the last `days` UTC days including today (1..30, default 7), most played first.
app.get("/api/plays", (req, res) => {
  const days = clampNum(req.query.days, 7, 1, PLAYS_KEEP_DAYS);
  res.set("Cache-Control", "public, max-age=300");
  res.json({ ok: true, days, gamemodes: playsRanking(days) });
});

// Publish or refresh a lobby. First publish for a lobbyId binds the caller's `secret`; later edits need it back.
app.post("/api/lobbies", (req, res) => {
  const b = req.body || {};
  const lobbyId = idStr(b.lobbyId);
  const ownerSteamId = idStr(b.ownerSteamId);
  const secret = str(b.secret, 128);
  if (!lobbyId || !ownerSteamId || !secret) {
    return res.status(400).json({ ok: false, error: "lobbyId, ownerSteamId and secret are required" });
  }
  const manifest = str(b.manifest, MAX_MANIFEST);
  const prefs = str(b.prefs, MAX_MANIFEST);

  const existing = lobbies.get(lobbyId);
  if (existing && existing.secret !== secret) {
    return res.status(403).json({ ok: false, error: "lobby is owned by another session" });
  }
  if (!existing && lobbies.size >= MAX_LOBBIES) {
    sweep();
    if (lobbies.size >= MAX_LOBBIES) return res.status(503).json({ ok: false, error: "directory full" });
  }

  const now = Date.now();
  const rec = {
    lobbyId,
    ownerSteamId,
    secret,
    hostName: str(b.hostName),
    lobbyName: str(b.lobbyName),
    kind: b.kind === "gamemode" ? "gamemode" : "vanilla",
    visibility: b.visibility === "private" ? "private" : "public",
    gamemode: str(b.gamemode, 64),
    gamemodeName: str(b.gamemodeName),
    enforce: bool(b.enforce),
    maxPlayers: clampNum(b.maxPlayers, 4, 2, 250),
    members: clampNum(b.members, 1, 0, 250),
    hasPassword: bool(b.hasPassword),
    pwHash: str(b.pwHash, 128),
    modSummary: str(b.modSummary, 256),
    gameVersion: str(b.gameVersion, 32),
    appBuild: str(b.appBuild, 64),
    mhash: str(b.mhash, 64),
    manifest,
    prefs,
    updatedAt: now,
    expiresAt: now + LOBBY_TTL_MS,
  };
  lobbies.set(lobbyId, rec);
  // The list snapshot is cached; a lobby that just turned private must not linger in it for another SNAPSHOT_MS.
  if (existing && existing.visibility !== rec.visibility) snapshot.at = 0;
  res.json({ ok: true });
});

// Keep a lobby alive + update its live member count. Requires the publishing secret.
app.post("/api/lobbies/:id/heartbeat", (req, res) => {
  const l = lobbies.get(idStr(req.params.id));
  const secret = str((req.body || {}).secret, 128);
  if (!l) return res.status(404).json({ ok: false, error: "unknown lobby" });
  if (l.secret !== secret) return res.status(403).json({ ok: false, error: "wrong secret" });
  l.members = clampNum((req.body || {}).members, l.members, 0, 250);
  l.updatedAt = Date.now();
  l.expiresAt = Date.now() + LOBBY_TTL_MS;
  res.json({ ok: true });
});

// Stop advertising a lobby (host left / went private). Requires the publishing secret.
app.delete("/api/lobbies/:id", (req, res) => {
  const id = idStr(req.params.id);
  const l = lobbies.get(id);
  const secret = str((req.body || {}).secret || req.get("x-lobby-secret"), 128);
  if (!l) return res.json({ ok: true }); // already gone
  if (l.secret !== secret) return res.status(403).json({ ok: false, error: "wrong secret" });
  lobbies.delete(id);
  res.json({ ok: true });
});

// The filterable directory. kind = vanilla|gamemode (omit for all); gamemode = an id; search = substring.
app.get("/api/lobbies", (req, res) => {
  const kind = str(req.query.kind, 16);
  const gamemode = str(req.query.gamemode, 64);
  const search = str(req.query.search, 64).toLowerCase();
  let out = lobbySnapshot();
  if (kind || gamemode || search) {
    out = out.filter((l) => {
      if (kind && l.kind !== kind) return false;
      if (gamemode && l.gamemode !== gamemode) return false;
      if (search) {
        const hay = (l.hostName + " " + l.lobbyName + " " + l.gamemodeName + " " + l.modSummary).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }
  // Let browsers and any proxy coalesce viewer polling; the game clients use HttpClient, which ignores this.
  res.set("Cache-Control", "public, max-age=5");
  res.json({ ok: true, count: out.length, lobbies: out });
});

// The full manifest + prefs for one lobby (the big payload the joiner validates against the Steam-lobby mhash).
app.get("/api/lobbies/:id/manifest", (req, res) => {
  const l = lobbies.get(idStr(req.params.id));
  if (!l) return res.status(404).json({ ok: false, error: "unknown lobby" });
  res.json({ ok: true, lobbyId: l.lobbyId, ownerSteamId: l.ownerSteamId, mhash: l.mhash, manifest: l.manifest, prefs: l.prefs });
});

// The structured mod list for one lobby - powers the website's per-lobby "view mods" modal. Parsed server-side from
// the stored raw manifest so the browser stays tiny and every Source maps to a safe, allowlisted link.
app.get("/api/lobbies/:id/mods", async (req, res) => {
  const l = lobbies.get(idStr(req.params.id));
  if (!l) return res.status(404).json({ ok: false, error: "unknown lobby" });
  const mods = await withResolved(parseManifestMods(l.manifest), MODS_BUDGET_MS);
  res.set("Cache-Control", "public, max-age=5");
  res.json({ ok: true, lobbyId: l.lobbyId, count: mods.length, mods });
});

// Resolve mods the caller could not source itself (the game's join checklist uses this). Body:
// { mods: [{ name, version, file, sha256 }] }, at most 64 rows. Each answer: { resolution, url, source, confidence };
// source is "ts:Owner-Name-1.2.3" only when the package's DLL hash matched, so a client may install it.
app.post("/api/resolve", async (req, res) => {
  const rows = Array.isArray(req.body?.mods) ? req.body.mods.slice(0, MAX_RESOLVE_ROWS) : null;
  if (!rows) return res.status(400).json({ ok: false, error: "mods must be a list" });
  const clean = rows.map((m) => ({
    name: str(m?.name), version: str(m?.version, 64), file: str(m?.file), sha256: str(m?.sha256, 64).toLowerCase(),
  }));
  const answers = await within(RESOLVE_BUDGET_MS, Promise.all(clean.map((m) => resolver.resolve(m))));
  const results = clean.map((m, i) => (answers ? answers[i] : resolver.cached(m))
    || { resolution: "pending", url: nexusSearch(m.name || m.file), source: "", confidence: "none" });
  res.json({ ok: true, results });
});

// hash 1.1.0 shipped with this address for its request-log upload, before the log got its own service. A 308
// keeps those installs working: it preserves the method and body, so the upload lands at the new ingest instead
// of failing until the player updates - and their file is only cleared once something has actually stored it.
app.post("/api/telemetry", (_req, res) =>
  res.redirect(308, "https://hash.doomods.com/api/telemetry"));

// Public website (lobby browser + landing). Served after the API so unknown /api/* still 404s as JSON below.
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "1h", extensions: ["html"] }));

app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));

app.listen(PORT, () => console.log(`[sidehustle-backend] listening on :${PORT}`));

// keep a stable server token available for future auth extensions without breaking the API
export const buildId = crypto.randomBytes(4).toString("hex");
