// Banc du controle de conformite de la vigie (lot 10, P2-03) : sans reseau ni Cloudflare.
//   node scripts/conformite-vigie.banc.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { blob, etiquetteDepot, juger, controler } from "./conformite-vigie.mjs";

const ATTENDUS = 7;
let n = 0; const ok = (m) => { n++; console.log("ok  " + m); };

// 1. l'empreinte est celle de git (identifiant de blob), fins de ligne CRLF ou LF
for (const f of ["cloudflare/vigie.js", "cloudflare/wrangler.toml"])
  assert.equal(blob(readFileSync(f, "utf8")), execFileSync("git", ["hash-object", f], { encoding: "utf8" }).trim(), f);
assert.equal(blob("a\r\nb\n"), blob("a\nb\n"));
assert.match(etiquetteDepot(), /^[0-9a-f]{10}-[0-9a-f]{10}$/);
ok("etiquette = identifiants de blob git de vigie.js et wrangler.toml, insensible aux fins de ligne");

const D = (id, pct = 100, quand = "2026-10-04T12:00:00Z") => ({ created_on: quand, source: "wrangler", versions: [{ version_id: id, percentage: pct }] });
// 2. conforme
assert.equal(juger({ deploiements: [D("v1")], version: { annotations: { "workers/tag": "aaa-bbb" }, metadata: { source: "wrangler" } }, attendue: "aaa-bbb" }).ok, true);
ok("version unique a 100 %, etiquette du depot : conforme");
// 3. version faite dans l'editeur : pas d'etiquette
let v = juger({ deploiements: [D("v2")], version: { annotations: {}, metadata: { source: "dash" } }, attendue: "aaa-bbb" });
assert.equal(v.ok, false); assert.match(v.motif, /PAS d'etiquette \(source : dash/);
ok("version de l'editeur Cloudflare (sans etiquette) : non conforme, source nommee");
// 4. depot modifie sans deploiement : autre etiquette
v = juger({ deploiements: [D("v3")], version: { annotations: { "workers/tag": "aaa-ccc" } }, attendue: "aaa-bbb" });
assert.equal(v.ok, false); assert.match(v.motif, /porte l'etiquette aaa-ccc, le depot aaa-bbb/);
ok("etiquette differente du depot : non conforme");
// 5. trafic reparti entre deux versions
v = juger({ deploiements: [{ created_on: "2026-10-04T12:00:00Z", versions: [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }] }], version: { annotations: { "workers/tag": "aaa-bbb" } }, attendue: "aaa-bbb" });
assert.equal(v.ok, false); assert.match(v.motif, /2 version\(s\)/);
ok("trafic reparti : non conforme");
// 6. c'est le deploiement le PLUS RECENT qui compte
v = juger({ deploiements: [D("ancien", 100, "2026-10-01T00:00:00Z"), D("recent", 100, "2026-10-04T00:00:00Z")], version: { annotations: { "workers/tag": "aaa-bbb" } }, attendue: "aaa-bbb" });
assert.match(v.motif, /version recent/);
ok("le deploiement actif est le plus recent");
// 7. bout a bout avec une fausse API : chemins appeles, jeton porte, erreur API = exception
process.env.CLOUDFLARE_ACCOUNT_ID = "compte"; process.env.CLOUDFLARE_API_TOKEN = "jeton";
const vus = [];
globalThis.fetch = async (url, o) => { vus.push({ url, auth: o.headers.Authorization });
  if (url.endsWith("/deployments")) return new Response(JSON.stringify({ success: true, result: { deployments: [D("v9")] } }));
  if (url.endsWith("/versions/v9")) return new Response(JSON.stringify({ success: true, result: { id: "v9", annotations: { "workers/tag": "aaa-bbb" }, metadata: { source: "wrangler" } } }));
  return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 }); };
assert.equal((await controler("aaa-bbb")).ok, true);
assert.deepEqual(vus.map((x) => x.url), ["https://api.cloudflare.com/client/v4/accounts/compte/workers/scripts/cursus-connect-vigie/deployments",
  "https://api.cloudflare.com/client/v4/accounts/compte/workers/scripts/cursus-connect-vigie/versions/v9"]);
assert.ok(vus.every((x) => x.auth === "Bearer jeton"));
globalThis.fetch = async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
await assert.rejects(controler("aaa-bbb"), /HTTP 403 - 10000 Authentication error/);
ok("API : deux appels, jeton porte, refus de l'API remonte tel quel");

assert.equal(n, ATTENDUS, `banc conformite : ${n} scenarios, ${ATTENDUS} attendus`);
console.log(`banc conformite : ${n} scenarios passes (${ATTENDUS} attendus)`);
