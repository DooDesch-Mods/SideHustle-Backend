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
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
const LOBBY_TTL_MS = parseInt(process.env.LOBBY_TTL_MS || "90000", 10); // expire a lobby ~90s after its last heartbeat
const SWEEP_MS = 30000;
const MAX_LOBBIES = parseInt(process.env.MAX_LOBBIES || "2000", 10);
const MAX_MANIFEST = parseInt(process.env.MAX_MANIFEST || "524288", 10); // 512 KB per payload - very generous

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
  for (const l of lobbies.values()) rows.push(publicView(l));
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  snapshot = { at: now, rows };
  return rows;
}

// ---- app --------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_MANIFEST + 4096 }));

app.get("/health", (_req, res) => res.json({ ok: true, lobbies: lobbies.size }));

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

// Public website (lobby browser + landing). Served after the API so unknown /api/* still 404s as JSON below.
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "1h", extensions: ["html"] }));

app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));

app.listen(PORT, () => console.log(`[sidehustle-backend] listening on :${PORT}`));

// keep a stable server token available for future auth extensions without breaking the API
export const buildId = crypto.randomBytes(4).toString("hex");
