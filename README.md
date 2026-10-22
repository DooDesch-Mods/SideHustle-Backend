# Side Hustle backend

> 🛟 **Need help or found a bug?** Get support at [support.doodesch.de/sidehustle-backend](https://support.doodesch.de/sidehustle-backend).

A tiny public **lobby directory + mod-manifest cache** for the Side Hustle Schedule I co-op mod, served over HTTP at `SideHustle.doodesch.de`.

Steam still does the multiplayer connection (FishySteamworks P2P) - the Steam lobby id stays the join handle. This service only carries the **discovery metadata** and the **mod manifest**, because Steam's lobby metadata drops large values and can't reliably ship a ~30-mod manifest to a non-friend joiner ("Sync unavailable").

## Trust model (no Steam publisher key needed)

The backend is an **untrusted public cache**. The host also writes a tiny `mhash` (manifest hash) onto the real Steam lobby - Steam authenticates that to the lobby owner and it always fits. A joiner fetches the full manifest here, hashes it, and only trusts it when that hash equals the Steam-lobby `mhash` **and** `GetLobbyOwner(lobbyId)` matches the claimed host. A forged manifest can't match the real owner's Steam-written `mhash`. A per-session `secret` gates edits/removal so one client can't hijack another's listing.

## API

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/health` | - | liveness (`{ok,lobbies,plays}`; `plays` = days of play counts held) |
| POST | `/api/lobbies` | `{lobbyId, ownerSteamId, secret, hostName, lobbyName, kind, visibility, gamemode, gamemodeName, enforce, maxPlayers, members, hasPassword, pwHash, modSummary, gameVersion, appBuild, mhash, manifest, prefs}` | publish/refresh a lobby (first publish binds `secret`); `visibility: "private"` keeps it out of the list |
| POST | `/api/lobbies/:id/heartbeat` | `{secret, members}` | keep alive + update member count (~every 30s) |
| DELETE | `/api/lobbies/:id` | `{secret}` (or `x-lobby-secret` header) | stop advertising |
| GET | `/api/lobbies?kind=&gamemode=&search=` | - | the filterable directory (no manifest payload) |
| GET | `/api/lobbies/:id/manifest` | - | full `{manifest, prefs, mhash, ownerSteamId}` |
| GET | `/api/lobbies/:id/mods` | - | the manifest as rows, unsourced mods looked up on Thunderstore and Nexus |
| POST | `/api/resolve` | `{mods: [{name, version, file, sha256}]}` (max 64) | where each mod is downloaded; `source` is a `ts:` spec only when the package's DLL hash matched |
| POST | `/api/plays` | `{gamemode, mode}` (`mode` = `host` or `solo`) | count one anonymous play of a gamemode for today (UTC); 429 past `PLAYS_PER_IP_HOUR` per IP or 200 gamemode ids per day |
| GET | `/api/plays?days=7` | - | plays per gamemode over the last `days` UTC days (1-30), most played first |

Lobbies expire ~90s after their last heartbeat.

## Website

The service also serves a small public **lobby browser** at the root (`/`) - a self-contained page (inline CSS/JS, no external assets) that polls `/api/lobbies` and lists the currently open co-op lobbies with type/gamemode/search filters. It's informational only: joining still happens in-game through Steam. The directory list is served from a short snapshot cache (`SNAPSHOT_MS`) so viewer traffic can't compete with the game clients publishing on the same process.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `LOBBY_TTL_MS` | `90000` | expire a lobby this long after its last heartbeat |
| `SNAPSHOT_MS` | `2000` | reuse a built directory snapshot for this long (coalesces website polling) |
| `MAX_LOBBIES` | `2000` | directory cap |
| `MAX_MANIFEST` | `524288` | max bytes per manifest/prefs payload |
| `PLAYS_FILE` | `/data/plays.json` | where play counts are saved (at most once a minute and on shutdown, last 30 days) |
| `PLAYS_PER_IP_HOUR` | `12` | plays one IP may report per rolling hour |

Mount a Dokploy volume at `/data`, or the play counts are lost on every redeploy.

## Run

```
npm install
npm start           # http://localhost:8080
# or
docker build -t sidehustle-backend . && docker run -p 8080:8080 sidehustle-backend
```

The lobby directory is in-memory only; a restart clears it and hosts simply re-publish on their next heartbeat. Play counts are the only data written to disk.
