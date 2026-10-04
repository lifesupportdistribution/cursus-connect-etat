// Cursus Connect — CONFORMITE DE LA VIGIE (lot 10 du registre d'audit 1.577.0, P2-03).
//
// La question : le code qui tourne chez Cloudflare est-il celui de ce depot ?
// Jusqu'au 04.10.2026 la vigie se deployait par copier-coller dans l'editeur ; rien
// ne garantissait que la version en service fut cloudflare/vigie.js. Desormais :
//   * vigie-deployer.yml deploie avec une ETIQUETTE = empreinte (identifiant de blob
//     git) de cloudflare/vigie.js et de cloudflare/wrangler.toml ;
//   * ce script verifie, par l'API Cloudflare, que le deploiement ACTIF sert 100 % du
//     trafic avec UNE version, et que cette version porte l'etiquette du depot.
// Une version faite dans l'editeur Cloudflare n'a pas d'etiquette : echec. Un depot
// modifie mais pas deploye a une autre empreinte : echec.
//
// Usage :
//   node scripts/conformite-vigie.mjs --etiquette      imprime l'etiquette du depot
//   node scripts/conformite-vigie.mjs [--attendre N]   verifie (N secondes de patience)
// Variables : CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID ; ETIQUETTE_ATTENDUE (facultative,
// pour la contre-preuve : une etiquette fausse doit faire echouer le controle).
// Sortie : 0 conforme · 1 ecart · 2 erreur (API, secret absent, reponse illisible).
// Aucune adresse ni aucun secret n'est imprime : ce journal est public.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = fileURLToPath(new URL("..", import.meta.url));
export const WORKER = "cursus-connect-vigie";
const FICHIERS = ["cloudflare/vigie.js", "cloudflare/wrangler.toml"];

/* Identifiant de blob git (ce que rend `git hash-object`) : l'empreinte d'un CONTENU,
   independante de l'historique. 10 caracteres par fichier : etiquette de 21 caracteres. */
export function blob(contenu) {
  const octets = Buffer.from(contenu.replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha1").update(`blob ${octets.length}\0`).update(octets).digest("hex");
}
export function etiquetteDepot(lire = (f) => readFileSync(RACINE + f, "utf8")) {
  return FICHIERS.map((f) => blob(lire(f)).slice(0, 10)).join("-");
}

/* Le jugement, sans reseau : deploiements et version tels que l'API les rend. */
export function juger({ deploiements, version, attendue }) {
  if (!Array.isArray(deploiements) || !deploiements.length) return { ok: false, motif: "aucun deploiement lu" };
  const actif = [...deploiements].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)))[0];
  const vs = actif.versions || [];
  if (vs.length !== 1 || Number(vs[0].percentage) !== 100)
    return { ok: false, motif: `le deploiement actif repartit le trafic sur ${vs.length} version(s) (${vs.map((v) => `${v.percentage} %`).join(", ")})` };
  const tag = version?.annotations?.["workers/tag"] || version?.metadata?.annotations?.["workers/tag"] || "";
  const source = version?.metadata?.source || actif.source || "inconnue";
  if (!tag) return { ok: false, motif: `la version active ${vs[0].version_id} n'a PAS d'etiquette (source : ${source} ; champs lus : ${Object.keys(version || {}).join(", ") || "aucun"}) : elle ne vient pas de vigie-deployer.yml` };
  if (tag !== attendue) return { ok: false, motif: `la version active porte l'etiquette ${tag}, le depot ${attendue} : code modifie sans deploiement, ou deploiement d'un autre code` };
  return { ok: true, motif: `version ${vs[0].version_id} (100 %), etiquette ${tag}, source ${source}, deployee le ${actif.created_on}` };
}

async function api(chemin) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER}${chemin}`,
    { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
  const corps = await r.json().catch(() => ({}));
  if (!r.ok || corps.success === false) {
    const erreurs = (corps.errors || []).map((e) => `${e.code} ${e.message}`).join(" ; ");
    throw new Error(`API Cloudflare ${chemin} : HTTP ${r.status}${erreurs ? " - " + erreurs : ""}`);
  }
  return corps.result;
}

export async function controler(attendue) {
  const res = await api("/deployments");
  const deploiements = res?.deployments;
  if (!Array.isArray(deploiements)) throw new Error(`reponse illisible de /deployments (cles : ${Object.keys(res || {}).join(", ")})`);
  const actif = [...deploiements].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)))[0];
  const id = actif?.versions?.[0]?.version_id;
  const version = id ? await api(`/versions/${id}`) : null;
  return juger({ deploiements, version, attendue });
}

async function principal() {
  const args = process.argv.slice(2);
  const attendue = process.env.ETIQUETTE_ATTENDUE || etiquetteDepot();
  if (args[0] === "--etiquette") { console.log(attendue); return 0; }
  for (const v of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])
    if (!process.env[v]) { console.error(`::error::secret ${v} absent`); return 2; }
  const patience = args[0] === "--attendre" ? Number(args[1] || 0) : 0;
  const fin = Date.now() + patience * 1000;
  console.log(`Vigie ${WORKER} — etiquette attendue (depot) : ${attendue}`);
  for (;;) {
    let v;
    try { v = await controler(attendue); }
    catch (e) { console.error(`::error::${e.message}`); return 2; }
    if (v.ok) { console.log(`✓ CONFORME : ${v.motif}`); return 0; }
    if (Date.now() >= fin) {
      console.error(`::error::VIGIE NON CONFORME : ${v.motif}. Redeployer depuis le depot (workflow vigie-deployer, « Run workflow »).`);
      return 1;
    }
    console.log(`  pas encore : ${v.motif} — nouvel essai dans 10 s`);
    await new Promise((ok) => setTimeout(ok, 10000));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) process.exit(await principal());
