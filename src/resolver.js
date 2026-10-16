// Mod resolver: turns a manifest row (name, version, DLL hash) into the page the mod is downloaded from.
//
// A host's manifest only carries a source for mods it knows the origin of (a Thunderstore install, or a mod that
// ships its own download link). Everything installed by hand arrives as "", and both the website and the game used
// to fall back to a Nexus keyword search for it. That search also misled: "MoreGuns 1.6.6" is "More Guns Forked"
// on Nexus, but a name-only match picks the older "More Guns" whose title is an exact hit.
//
// The resolver asks in this order and stops at the first certain answer:
//   1. Thunderstore. The whole Schedule I package list is one public request (cached). Candidates whose name or
//      file matches are checked by downloading the package zip and hashing its DLLs against the manifest's
//      sha256 - a match there is proof, not a guess, and it is the only result marked "verified".
//   2. Nexus. The public GraphQL API (anonymous) returns title and version. One candidate with the same version
//      wins; otherwise a title that can only mean one mod; otherwise nothing.
//   3. The Nexus keyword search, as before.
//
// Answers are cached in memory, so a lobby list that is opened from many browsers asks each source once.

import crypto from "node:crypto";
import zlib from "node:zlib";

const TS_INDEX_URL = "https://thunderstore.io/c/schedule-i/api/v1/package/";
const NEXUS_GRAPHQL = "https://api.nexusmods.com/v2/graphql";
const NEXUS_GAME = "schedule1";
const USER_AGENT = "SideHustle-Backend (+https://sidehustle.doodesch.de)";

const TS_INDEX_TTL_MS = 60 * 60 * 1000;
const HIT_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_TS_VERIFY = 6; // package versions downloaded per lookup at most
const MAX_CACHE = 5000;

// ---- names ------------------------------------------------------------------------------------------------------

// A search term Nexus can match: letters/digits only, run-together words split at their capitals.
// Kept identical to NexusLookup.SearchTerm in the mod, so a search link is the same here and in game.
export const searchTerm = (name) =>
  (name || "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/(?<=\p{Ll}|\p{N})(?=\p{Lu})/gu, " ")
    .replace(/(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const nexusSearchUrl = (name) =>
  "https://www.nexusmods.com/games/schedule1/search?keyword=" + encodeURIComponent(searchTerm(name));

export const nexusPageUrl = (modId) => `https://www.nexusmods.com/${NEXUS_GAME}/mods/${modId}`;

/** Lowercase letters and digits only: "More_Guns_Forked" and "MoreGuns" compare as "moregunsforked" / "moreguns". */
export const compact = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** "v1.6.6" and "1.6.6" are the same version; so are "1.6" and "1.6.0". */
export function normVersion(v) {
  let s = (v || "").trim().toLowerCase().replace(/^v(?=\d)/, "");
  while (/\.0$/.test(s) && s.split(".").length > 2) s = s.slice(0, -2);
  return s;
}

// Thunderstore packages are often split per game runtime ("..._IL2CPP", "...Mono"). The suffix is not part of the
// mod's name, so it is dropped before a name is compared.
const RUNTIME_SUFFIX = /(il2cpp|mono|melonloader|ml)$/;
export const baseName = (pkgName) => {
  let c = compact(pkgName);
  for (let i = 0; i < 2 && RUNTIME_SUFFIX.test(c) && c.replace(RUNTIME_SUFFIX, "").length >= 3; i++) c = c.replace(RUNTIME_SUFFIX, "");
  return c;
};

// ---- zip --------------------------------------------------------------------------------------------------------

/** sha256 (lowercase hex) of every .dll inside a zip buffer. Stored and deflated entries; anything else is skipped. */
export function dllHashesInZip(buf) {
  const out = [];
  // End of central directory: the last 0x06054b50 signature within the final 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("broken central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.dll$/i.test(name)) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = zlib.inflateRawSync(data);
    else continue;
    out.push({ name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  }
  return out;
}

// ---- picking ----------------------------------------------------------------------------------------------------

/**
 * Thunderstore packages that may be this mod: the package's base name equals the mod name or the DLL name, or
 * starts/ends with it ("MoreGuns" -> "More_Guns_Forked_IL2CPP"). Returns [{pkg, ver}] for the version that matches
 * the manifest, or every version when the manifest has none.
 */
export function tsCandidates(index, { name, file, version }) {
  const keys = [compact(name), compact((file || "").replace(/\.dll$/i, ""))].filter((k) => k.length >= 4);
  if (!keys.length) return [];
  const want = normVersion(version);
  const out = [];
  for (const pkg of index) {
    if (pkg.is_deprecated) continue;
    const b = baseName(pkg.name);
    if (!keys.some((k) => b === k || b.startsWith(k) || b.endsWith(k))) continue;
    for (const ver of pkg.versions || []) {
      if (want && normVersion(ver.version_number) !== want) continue;
      out.push({ pkg, ver, exact: keys.includes(b) });
      if (!want) break; // newest only when there is nothing to compare against
    }
  }
  // An exact name is checked before a longer one that merely starts with it.
  return out.sort((a, b) => Number(b.exact) - Number(a.exact));
}

/**
 * The ONE Nexus mod a manifest row can mean, or 0. A single candidate with the same version wins outright.
 * Without one, the title has to decide: a single exact title, a single "Name - tagline" title, or the only
 * published mod with that name at all. Two equally good answers are never guessed between.
 */
export function pickNexus(term, version, candidates, totalCount) {
  if (!term || !candidates?.length) return { modId: 0 };
  const want = normVersion(version);
  const t = term.toLowerCase();
  const norm = (m) => searchTerm(m.name).toLowerCase();
  if (want) {
    // A version only proves something among ALL the mods that match the name. When the answer was cut off at
    // `count`, a generic name ("Trash" has 18) has more matches than we saw, so only an exact title may win on
    // version there.
    const seenAll = totalCount <= candidates.length;
    const pool = seenAll ? candidates : candidates.filter((m) => norm(m) === t);
    const same = pool.filter((m) => normVersion(m.version) === want);
    if (same.length === 1) return { modId: same[0].modId, by: "version" };
    if (same.length > 1) {
      const exact = same.filter((m) => norm(m) === t);
      return exact.length === 1 ? { modId: exact[0].modId, by: "version" } : { modId: 0 };
    }
  }
  const exact = candidates.filter((m) => norm(m) === t);
  if (exact.length) return exact.length === 1 ? { modId: exact[0].modId, by: "name" } : { modId: 0 };
  const titled = candidates.filter((m) => norm(m).startsWith(t + " "));
  if (titled.length) return titled.length === 1 ? { modId: titled[0].modId, by: "name" } : { modId: 0 };
  return totalCount === 1 && candidates.length === 1 ? { modId: candidates[0].modId, by: "name" } : { modId: 0 };
}

// ---- resolver ---------------------------------------------------------------------------------------------------

export function createResolver({ fetchImpl = globalThis.fetch, log = (m) => console.log("[resolver] " + m), now = Date.now } = {}) {
  let tsIndex = null; // { at, list }
  let tsIndexLoading = null;
  const zipHashes = new Map(); // "Owner-Name-1.2.3" -> Promise<string[]>
  const answers = new Map(); // key -> { at, ttl, result }
  const inFlight = new Map(); // key -> Promise<result>

  async function getJson(url, init) {
    const r = await fetchImpl(url, { ...init, headers: { "User-Agent": USER_AGENT, ...(init?.headers || {}) } });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.json();
  }

  async function thunderstoreIndex() {
    if (tsIndex && now() - tsIndex.at < TS_INDEX_TTL_MS) return tsIndex.list;
    if (!tsIndexLoading) {
      tsIndexLoading = getJson(TS_INDEX_URL)
        .then((list) => {
          if (!Array.isArray(list)) throw new Error("thunderstore index is not a list");
          tsIndex = { at: now(), list };
          log(`thunderstore index loaded: ${list.length} packages`);
          return list;
        })
        .finally(() => { tsIndexLoading = null; });
    }
    try {
      return await tsIndexLoading;
    } catch (e) {
      if (tsIndex) {
        log(`thunderstore index refresh failed, keeping the old one: ${e.message}`);
        return tsIndex.list;
      }
      throw e;
    }
  }

  function packageDllHashes(ver) {
    const key = ver.full_name;
    if (!zipHashes.has(key)) {
      const p = (async () => {
        if (ver.file_size && ver.file_size > MAX_ZIP_BYTES) {
          log(`${key}: ${ver.file_size} bytes is over the download limit, not checked`);
          return [];
        }
        const r = await fetchImpl(ver.download_url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
        if (!r.ok) throw new Error(`${key} download answered ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const hashes = dllHashesInZip(buf).map((d) => d.sha256);
        log(`${key}: ${hashes.length} dll(s) hashed`);
        return hashes;
      })();
      p.catch((e) => { log(`${key}: ${e.message}`); zipHashes.delete(key); });
      zipHashes.set(key, p);
    }
    return zipHashes.get(key);
  }

  async function viaThunderstore(row) {
    const sha = (row.sha256 || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    const cands = tsCandidates(await thunderstoreIndex(), row).slice(0, MAX_TS_VERIFY);
    for (const { pkg, ver } of cands) {
      let hashes;
      try { hashes = await packageDllHashes(ver); } catch { continue; }
      if (hashes.includes(sha)) {
        return {
          resolution: "thunderstore",
          url: pkg.package_url,
          source: "ts:" + ver.full_name,
          confidence: "verified",
        };
      }
    }
    return null;
  }

  async function viaNexus(row, term) {
    if (term.replace(/ /g, "").length < 3) return null;
    const query =
      "query($game:String!,$name:String!){mods(filter:{gameDomainName:[{value:$game,op:EQUALS}]," +
      'status:[{value:"published",op:EQUALS}],name:[{value:$name,op:WILDCARD}]},count:10)' +
      "{totalCount nodes{modId name version}}}";
    const d = await getJson(NEXUS_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { game: NEXUS_GAME, name: term } }),
    });
    if (d.errors?.length) throw new Error("nexus: " + JSON.stringify(d.errors[0]).slice(0, 200));
    const mods = d.data?.mods;
    if (!mods) throw new Error("nexus answered without data.mods");
    const pick = pickNexus(term, row.version, mods.nodes || [], mods.totalCount || 0);
    if (!pick.modId) return null;
    return { resolution: "nexus", url: nexusPageUrl(pick.modId), source: "", confidence: pick.by };
  }

  async function lookUp(row, term) {
    let failed = false;
    try {
      const ts = await viaThunderstore(row);
      if (ts) return { result: ts, failed };
    } catch (e) {
      failed = true;
      log(`thunderstore lookup for "${term}" failed: ${e.message}`);
    }
    try {
      const nx = await viaNexus(row, term);
      if (nx) return { result: nx, failed };
    } catch (e) {
      failed = true;
      log(`nexus lookup for "${term}" failed: ${e.message}`);
    }
    return { result: { resolution: "search", url: nexusSearchUrl(term), source: "", confidence: "none" }, failed };
  }

  /** Resolve one manifest row: { name, version, file, sha256 }. Never throws; the worst answer is the search. */
  async function resolve(row) {
    const name = row?.name || (row?.file || "").replace(/\.dll$/i, "");
    const term = searchTerm(name);
    const key = `${term.toLowerCase()}|${normVersion(row?.version)}|${(row?.sha256 || "").toLowerCase()}`;
    const hit = answers.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.result;
    if (inFlight.has(key)) return inFlight.get(key);
    const p = lookUp({ ...row, name }, term)
      .then(({ result, failed }) => {
        // A lookup that failed on the way is not remembered as a miss: the next request asks again.
        if (!(failed && result.resolution === "search")) {
          if (answers.size >= MAX_CACHE) answers.delete(answers.keys().next().value);
          answers.set(key, { at: now(), ttl: result.resolution === "search" ? MISS_TTL_MS : HIT_TTL_MS, result });
        }
        log(`"${term}" ${row?.version || "-"} -> ${result.resolution} (${result.confidence}) ${result.url}`);
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  /** The answer if one is already cached, else null. Never touches the network. */
  function cached(row) {
    const name = row?.name || (row?.file || "").replace(/\.dll$/i, "");
    const key = `${searchTerm(name).toLowerCase()}|${normVersion(row?.version)}|${(row?.sha256 || "").toLowerCase()}`;
    const hit = answers.get(key);
    return hit && now() - hit.at < hit.ttl ? hit.result : null;
  }

  return { resolve, cached };
}
