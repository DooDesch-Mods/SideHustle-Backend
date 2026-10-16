import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { baseName, createResolver, dllHashesInZip, normVersion, pickNexus, searchTerm, tsCandidates } from "../src/resolver.js";

test("searchTerm splits run-together names like the mod does", () => {
  assert.equal(searchTerm("MoreGuns"), "More Guns");
  assert.equal(searchTerm("SIAKImperium"), "SIAK Imperium");
  assert.equal(searchTerm("Mod Manager & Phone App"), "Mod Manager Phone App");
});

test("normVersion treats v-prefix and trailing zeros as the same version", () => {
  assert.equal(normVersion("v1.6.6"), "1.6.6");
  assert.equal(normVersion("1.6.0"), "1.6");
  assert.equal(normVersion("0.4.5f22"), "0.4.5f22");
});

test("baseName drops the runtime suffix of a Thunderstore package", () => {
  assert.equal(baseName("More_Guns_Forked_IL2CPP"), "moregunsforked");
  assert.equal(baseName("GunControlMono"), "guncontrol");
  assert.equal(baseName("Mono"), "mono");
});

const nexusMoreGuns = [
  { modId: 2528, name: "More Guns Forked", version: "1.6.6" },
  { modId: 1690, name: "More Guns (Updated)", version: "0.4.5f22" },
  { modId: 904, name: "More Guns", version: "v1.4.2" },
];

test("pickNexus prefers the one candidate with the same version over an exact title", () => {
  assert.deepEqual(pickNexus("More Guns", "1.6.6", nexusMoreGuns, 3), { modId: 2528, by: "version" });
  assert.deepEqual(pickNexus("More Guns", "1.4.2", nexusMoreGuns, 3), { modId: 904, by: "version" });
});

test("pickNexus does not trust a version match when the answer was cut off", () => {
  const cut = [
    { modId: 1, name: "Trash Grabber", version: "1.0.0" },
    { modId: 2, name: "Trash Recycler", version: "2.0" },
  ];
  assert.deepEqual(pickNexus("Trash", "1.0.0", cut, 40), { modId: 0 });
  assert.deepEqual(pickNexus("Trash", "1.0.0", cut, 2), { modId: 1, by: "version" });
});

test("pickNexus falls back to the title when no version matches", () => {
  assert.deepEqual(pickNexus("More Guns", "9.9.9", nexusMoreGuns, 3), { modId: 904, by: "name" });
  assert.deepEqual(pickNexus("Guns", "", nexusMoreGuns, 3), { modId: 0 });
});

const tsIndex = [
  { name: "More_Guns_Forked_IL2CPP", is_deprecated: false, versions: [{ version_number: "1.6.6", full_name: "U-More_Guns_Forked_IL2CPP-1.6.6" }, { version_number: "1.6.5", full_name: "U-More_Guns_Forked_IL2CPP-1.6.5" }] },
  { name: "MoreGuns", is_deprecated: false, versions: [{ version_number: "1.3.0", full_name: "Universal-MoreGuns-1.3.0" }] },
  { name: "Unrelated", is_deprecated: false, versions: [{ version_number: "1.6.6", full_name: "X-Unrelated-1.6.6" }] },
];

test("tsCandidates keeps the packages with the manifest's version", () => {
  const c = tsCandidates(tsIndex, { name: "MoreGuns", file: "MoreGuns.dll", version: "1.6.6" });
  assert.deepEqual(c.map((x) => x.ver.full_name), ["U-More_Guns_Forked_IL2CPP-1.6.6"]);
});

test("tsCandidates checks an exact name first", () => {
  const c = tsCandidates(tsIndex, { name: "MoreGuns", file: "", version: "" });
  assert.equal(c[0].ver.full_name, "Universal-MoreGuns-1.3.0");
});

// A minimal zip with one stored and one deflated entry, built by hand so the reader is tested without a library.
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("dllHashesInZip hashes stored and deflated DLLs and skips other files", () => {
  const a = Buffer.from("first dll bytes ".repeat(50));
  const b = Buffer.from("second dll");
  const zip = makeZip([
    { name: "Mods/A.dll", data: a, deflate: true },
    { name: "README.md", data: Buffer.from("x"), deflate: false },
    { name: "B.DLL", data: b, deflate: false },
  ]);
  assert.deepEqual(dllHashesInZip(zip).map((d) => d.sha256), [sha(a), sha(b)]);
});

test("resolve verifies a Thunderstore package by its DLL hash", async () => {
  const dll = Buffer.from("more guns il2cpp build");
  const zip = makeZip([{ name: "Mods/MoreGuns.dll", data: dll, deflate: true }]);
  const index = [{
    name: "More_Guns_Forked_IL2CPP", package_url: "https://thunderstore.io/c/schedule-i/p/U/More_Guns_Forked_IL2CPP/", is_deprecated: false,
    versions: [{ version_number: "1.6.6", full_name: "U-More_Guns_Forked_IL2CPP-1.6.6", download_url: "https://ts.test/zip", file_size: zip.length }],
  }];
  const fetchImpl = async (url) => {
    if (url.includes("/api/v1/package/")) return { ok: true, json: async () => index };
    if (url === "https://ts.test/zip") return { ok: true, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) };
    throw new Error("unexpected " + url);
  };
  const r = createResolver({ fetchImpl, log: () => {} });
  const got = await r.resolve({ name: "MoreGuns", version: "1.6.6", file: "MoreGuns.dll", sha256: sha(dll) });
  assert.equal(got.resolution, "thunderstore");
  assert.equal(got.confidence, "verified");
  assert.equal(got.source, "ts:U-More_Guns_Forked_IL2CPP-1.6.6");
});

test("resolve falls back to Nexus by version when no package hash matches", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/api/v1/package/")) return { ok: true, json: async () => [] };
    if (url.includes("graphql")) return { ok: true, json: async () => ({ data: { mods: { totalCount: 3, nodes: nexusMoreGuns } } }) };
    throw new Error("unexpected " + url);
  };
  const r = createResolver({ fetchImpl, log: () => {} });
  const got = await r.resolve({ name: "MoreGuns", version: "1.6.6", file: "MoreGuns.dll", sha256: "0".repeat(64) });
  assert.equal(got.url, "https://www.nexusmods.com/schedule1/mods/2528");
  assert.equal(got.confidence, "version");
});

test("resolve answers with the search when every source is down, and does not remember it", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("offline"); };
  const r = createResolver({ fetchImpl, log: () => {} });
  const row = { name: "MoreGuns", version: "1.6.6", file: "MoreGuns.dll", sha256: "0".repeat(64) };
  assert.equal((await r.resolve(row)).resolution, "search");
  const before = calls;
  await r.resolve(row);
  assert.ok(calls > before, "a failed lookup is asked again");
});
