import w, { sonder } from "./vigie.js";
import assert from "node:assert/strict";

// --- faux D1 (coherent, en memoire) ---
const table = new Map();
const D1 = { prepare(sql) { let args = []; return {
  bind(...a) { args = a; return this; },
  async run() { if (sql.startsWith("INSERT")) { const [env, verdict, depuis, en_attente, compte, derniere_alerte, detail, maj] = args; table.set(env, { env, verdict, depuis, en_attente, compte, derniere_alerte, detail, maj }); } return {}; },
  async first() { return table.get(args[0]) || null; } }; } };

// --- faux reseau ---
let reponses = {}, appels = [];
globalThis.fetch = async (url, o = {}) => {
  appels.push({ url, o });
  if (url.startsWith("https://api.pushover.net")) { const p = Object.fromEntries(o.body); appels.at(-1).pushover = p; return globalThis.PUSHOVER_KO ? new Response('{"status":0,"errors":["bad"]}', { status: 400 }) : new Response('{"status":1}', { status: 200 }); }
  if (url.startsWith("https://api.github.com")) return new Response(null, { status: 204 });
  if (url.startsWith("https://raw.githubusercontent.com")) return new Response(JSON.stringify({ composants: { application: { jours: { "2026-09-18": { n: 40, ko: 1 } } } } }));
  const r = reponses[url];
  if (r === "timeout") { const e = new Error("x"); e.name = "AbortError"; throw e; }
  if (r === "reseau") throw new Error("ECONNRESET");
  return new Response(JSON.stringify(r.corps), { status: r.status, headers: { "content-type": "application/json" } });
};
const OK = { status: 200, corps: { version: "1.574.7", etat: "ok", base: "ok", stockage: "ok", cloisonnement: "actif", schema: 14, schemaRequis: 14 } };
const KO = { status: 503, corps: { version: "1.574.7", etat: "hors service", base: "indisponible", stockage: "ok", cloisonnement: "actif", schema: 14, schemaRequis: 14 } };
const DEG = { status: 200, corps: { version: "1.575.0", etat: "degrade", base: "ok", stockage: "ok", cloisonnement: "actif", courriel: "indisponible" } };
const env = { SONDE_PRODUCTION_URL: "https://prod/api/sante", SONDE_TEST_URL: "https://test/api/sante", GITHUB_JETON: "g", PUSHOVER_JETON: "p", PUSHOVER_UTILISATEUR: "u", ETAT: D1 };
const tick = (iso) => w.scheduled({ scheduledTime: Date.parse(iso) }, env, {});
const pushs = () => appels.filter((a) => a.pushover).map((a) => a.pushover);
const github = () => appels.filter((a) => a.url.includes("api.github.com")).length;
const raz = () => { appels = []; };
let n = 0; const ok = (m) => { n++; console.log("ok  " + m); };

// 1. tout va bien, minute 07 : dispatch, aucun push
reponses = { "https://prod/api/sante": OK, "https://test/api/sante": OK };
await tick("2026-09-19T10:07:00Z"); assert.equal(github(), 1); assert.equal(pushs().length, 0); ok("minute 07 : dispatch GitHub, aucune alerte"); raz();
await tick("2026-09-19T10:08:00Z"); assert.equal(github(), 0); ok("minute 08 : pas de dispatch"); raz();
// 2. premiere panne : en attente, pas d'alerte
reponses["https://prod/api/sante"] = KO;
await tick("2026-09-19T10:09:00Z"); assert.equal(pushs().length, 0); assert.equal(table.get("production").en_attente, "hors_service"); ok("1er echec : en attente, pas d'alerte"); raz();
// 3. second echec : urgence
await tick("2026-09-19T10:10:00Z"); let p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "2"); assert.equal(p[0].retry, "60"); assert.equal(p[0].expire, "3600");
assert.match(p[0].message, /HORS SERVICE depuis 12:10/); assert.match(p[0].message, /base indisponible/); assert.equal(table.get("production").verdict, "hors_service"); ok("2e echec : alerte urgence, heure de Paris, cause"); raz();
// 4. minute suivante : silence
await tick("2026-09-19T10:11:00Z"); assert.equal(pushs().length, 0); ok("panne qui dure : pas de nouvelle alerte a la minute"); raz();
// 5. une heure plus tard : rappel haute (le rappel compare a l'horloge reelle -> on antidate derniere_alerte)
table.get("production").derniere_alerte = "2026-09-19T10:10:00.000Z"; // [v2] temps simule : 61 min avant 11:11
await tick("2026-09-19T11:11:00Z"); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "1"); assert.match(p[0].message, /Toujours hors service/); ok("apres 1 h : rappel priorite haute"); raz();
// 6. retablissement : 2 releves ok, puis priorite normale avec duree
reponses["https://prod/api/sante"] = OK;
await tick("2026-09-19T11:12:00Z"); assert.equal(pushs().length, 0);
await tick("2026-09-19T11:13:00Z"); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "0"); assert.match(p[0].message, /Retabli a 13:13 apres 1 h 03/); ok("retablissement : priorite normale, duree exacte"); raz();
// 7. un echec isole puis ok : aucune alerte
reponses["https://prod/api/sante"] = "timeout"; await tick("2026-09-19T11:14:00Z");
reponses["https://prod/api/sante"] = OK; await tick("2026-09-19T11:15:00Z"); assert.equal(pushs().length, 0); assert.equal(table.get("production").en_attente, null); ok("hoquet isole : aucune alerte, attente effacee"); raz();
// 8. degrade -> priorite haute
reponses["https://prod/api/sante"] = DEG; await tick("2026-09-19T11:16:00Z"); await tick("2026-09-19T11:17:00Z");
p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "1"); assert.match(p[0].message, /DEGRADE/); assert.match(p[0].message, /courriel indisponible/); ok("degrade : priorite haute, cause courriel"); raz();
reponses["https://prod/api/sante"] = OK; await tick("2026-09-19T11:18:00Z"); await tick("2026-09-19T11:19:00Z"); raz();
// 9. test : sonde aux multiples de 5 seulement, priorite 0
reponses["https://test/api/sante"] = "reseau";
await tick("2026-09-19T11:21:00Z"); assert.equal(appels.filter((a) => a.url.startsWith("https://test")).length, 0); ok("test : pas sonde hors multiples de 5"); raz();
await tick("2026-09-19T11:25:00Z"); await tick("2026-09-19T11:30:00Z"); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "0"); assert.match(p[0].title, /test/); assert.match(p[0].message, /INJOIGNABLE/); ok("test : alerte apres 2 sondes, priorite normale"); raz();
table.get("test").derniere_alerte = "2026-09-19T09:30:00.000Z"; // [v2] temps simule
await tick("2026-09-19T11:35:00Z"); assert.equal(pushs().length, 0); ok("test : pas de rappel horaire"); raz();
// 10. Pushover en panne : l'etat n'est pas ecrit, la minute suivante reessaie
reponses["https://prod/api/sante"] = KO; await tick("2026-09-19T11:36:00Z");
globalThis.PUSHOVER_KO = true; await assert.rejects(tick("2026-09-19T11:37:00Z"), /Pushover refuse/); assert.equal(table.get("production").verdict, "ok"); raz();
globalThis.PUSHOVER_KO = false; await tick("2026-09-19T11:38:00Z"); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "2"); assert.equal(table.get("production").verdict, "hors_service"); ok("Pushover en echec : invocation en echec, reessai la minute suivante"); raz();
// 11. preuve de vie a 06:00 UTC, priorite -2, historique lu
await tick("2026-09-19T06:00:00Z"); p = pushs().filter((x) => x.priority === "-2"); assert.equal(p.length, 1); assert.match(p[0].message, /Production : hors service/); assert.match(p[0].message, /Hier, GitHub : 40 releves, 1 au rouge/); ok("preuve de vie : muette, etats et historique"); raz();
// 12. sonder() : classification
reponses["https://x/"] = { status: 500, corps: { erreur: "x" } }; assert.equal((await sonder("https://x/")).verdict, "injoignable");
reponses["https://x/"] = { status: 200, corps: { etat: "hors service" } }; assert.equal((await sonder("https://x/")).verdict, "hors_service");
reponses["https://x/"] = "timeout"; const s = await sonder("https://x/"); assert.equal(s.verdict, "injoignable"); assert.match(s.detail, /10 s/); ok("classification des reponses");
// 13. erreur GitHub n'empeche pas la sonde
globalThis.fetch = (f => async (u, o) => u.startsWith("https://api.github.com") ? new Response("nope", { status: 401 }) : f(u, o))(globalThis.fetch);
reponses["https://prod/api/sante"] = OK; await assert.rejects(tick("2026-09-19T12:22:00Z"), /dispatch refuse : HTTP 401/); ok("GitHub en echec : invocation en echec, sonde quand meme faite");
console.log(`banc : ${n} scenarios passes`);
