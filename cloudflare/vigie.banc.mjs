// Banc de la vigie : rejoue ses comportements sans reseau ni Cloudflare.
// D1 est simule par le SQLite integre a Node (D1 EST du SQLite) : les requetes
// sont celles du Worker, executees pour de vrai. Heures SIMULEES uniquement.
//   node cloudflare/vigie.banc.mjs
import w, { sonder, recevoirSignal, tableau, verifierEcheances, abonnement } from "./vigie.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

// --- D1 sur SQLite ---
const db = new DatabaseSync(":memory:");
const D1 = {
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = a; return st; },
      async run() { db.prepare(sql).run(...args); return {}; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
    };
    return st;
  },
  async batch(sts) { for (const s of sts) await s.run(); return []; },
};
const ligne = (sql, ...a) => db.prepare(sql).get(...a);

// --- faux reseau ---
let reponses = {}, appels = [], rdap = { date: null, ko: false }, tem = { ko: false };
globalThis.fetch = async (url, o = {}) => {
  appels.push({ url, o });
  if (url.startsWith("https://api.pushover.net")) { const p = Object.fromEntries(o.body); appels.at(-1).pushover = p; return globalThis.PUSHOVER_KO ? new Response('{"status":0,"errors":["bad"]}', { status: 400 }) : new Response('{"status":1}', { status: 200 }); }
  if (url.startsWith("https://api.github.com")) return new Response(null, { status: 204 });
  if (url.startsWith("https://raw.githubusercontent.com")) return new Response(JSON.stringify({ composants: { application: { jours: { "2026-09-18": { n: 40, ko: 1 } } } } }));
  if (url.startsWith("https://api.scaleway.com/transactional-email/")) { appels.at(-1).tem = JSON.parse(o.body); appels.at(-1).auth = o.headers["X-Auth-Token"]; return tem.ko ? new Response('{"message":"refus"}', { status: 403 }) : new Response('{"emails":[{"id":"x"}]}', { status: 200 }); }
  if (url.startsWith("https://rdap.org/")) return rdap.ko ? new Response("", { status: 503 }) : new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2025-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: rdap.date + "T12:00:00Z" }] }));
  const r = reponses[url];
  if (r === "timeout") { const e = new Error("x"); e.name = "AbortError"; throw e; }
  if (r === "reseau") throw new Error("ECONNRESET");
  return new Response(JSON.stringify(r.corps), { status: r.status, headers: { "content-type": "application/json" } });
};
const OK = { status: 200, corps: { version: "1.575.0", etat: "ok", base: "ok", stockage: "ok", courriel: "ok", cloisonnement: "actif", tls: "ca_fournie", schema: 14, schemaRequis: 14 } };
const KO = { status: 503, corps: { version: "1.575.0", etat: "hors service", base: "indisponible", stockage: "ok", courriel: "ok", cloisonnement: "actif", tls: "ca_fournie", schema: 14, schemaRequis: 14 } };
const DEG = { status: 200, corps: { version: "1.575.0", etat: "degrade", base: "ok", stockage: "ok", cloisonnement: "actif", tls: "ca_fournie", courriel: "indisponible" } };
const env = { SONDE_PRODUCTION_URL: "https://prod/api/sante", SONDE_TEST_URL: "https://test/api/sante", GITHUB_JETON: "g", PUSHOVER_JETON: "p", PUSHOVER_UTILISATEUR: "u", VIGIE_SIGNAL_JETON: "jeton-signal", VIGIE_TABLEAU_MDP: "mdp", ETAT: D1,
  SCW_TEM_CLE: "cle-tem", SCW_PROJET: "projet-1", ABONNEMENT_EXPEDITEUR: "etat@cursusconnect.com", ABONNEMENT_ORIGINE: "https://status.cursusconnect.com", VIGIE_URL: "https://vigie.test" };
const tems = () => appels.filter((a) => a.tem).map((a) => a.tem);
const tick = (iso, e = env) => w.scheduled({ scheduledTime: Date.parse(iso) }, e, {});
const pushs = () => appels.filter((a) => a.pushover).map((a) => a.pushover);
const github = () => appels.filter((a) => a.url.includes("api.github.com")).length;
const raz = () => { appels = []; };
const signal = (corps, jeton = "jeton-signal", iso = "2026-09-19T12:00:00Z", e = env) => recevoirSignal(new Request("https://vigie/signal", { method: "POST", headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" }, body: JSON.stringify(corps) }), e, new Date(iso));
let n = 0; const ok = (m) => { n++; console.log("ok  " + m); };

// 1. tout va bien, minute 07 : dispatch, aucun push
reponses = { "https://prod/api/sante": OK, "https://test/api/sante": OK };
await tick("2026-09-19T10:07:00Z"); assert.equal(github(), 1); assert.equal(pushs().length, 0); ok("minute 07 : dispatch GitHub, aucune alerte"); raz();
await tick("2026-09-19T10:08:00Z"); assert.equal(github(), 0); ok("minute 08 : pas de dispatch"); raz();
// 2. premiere panne : en attente, pas d'alerte
reponses["https://prod/api/sante"] = KO;
await tick("2026-09-19T10:09:00Z"); assert.equal(pushs().length, 0); assert.equal(ligne("SELECT en_attente FROM etat WHERE env='production'").en_attente, "hors_service"); ok("1er echec : en attente, pas d'alerte"); raz();
// 3. second echec : urgence
await tick("2026-09-19T10:10:00Z"); let p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "2"); assert.equal(p[0].retry, "60"); assert.equal(p[0].expire, "3600");
assert.match(p[0].message, /HORS SERVICE depuis 12:10/); assert.match(p[0].message, /base indisponible/); assert.equal(ligne("SELECT verdict FROM etat WHERE env='production'").verdict, "hors_service"); ok("2e echec : alerte urgence, heure de Paris, cause"); raz();
// 4. minute suivante : silence
await tick("2026-09-19T10:11:00Z"); assert.equal(pushs().length, 0); ok("panne qui dure : pas de nouvelle alerte a la minute"); raz();
// 5. une heure plus tard (temps simule) : rappel haute
await tick("2026-09-19T11:11:00Z"); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "1"); assert.match(p[0].message, /Toujours hors service/); ok("apres 1 h : rappel priorite haute"); raz();
// 6. retablissement : 2 releves ok, puis priorite normale avec duree
reponses["https://prod/api/sante"] = OK;
await tick("2026-09-19T11:12:00Z"); assert.equal(pushs().length, 0);
await tick("2026-09-19T11:13:00Z"); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "0"); assert.match(p[0].message, /Retabli a 13:13 apres 1 h 03/); ok("retablissement : priorite normale, duree exacte"); raz();
// 7. un echec isole puis ok : aucune alerte
reponses["https://prod/api/sante"] = "timeout"; await tick("2026-09-19T11:14:00Z");
reponses["https://prod/api/sante"] = OK; await tick("2026-09-19T11:15:00Z"); assert.equal(pushs().length, 0); assert.equal(ligne("SELECT en_attente FROM etat WHERE env='production'").en_attente, null); ok("hoquet isole : aucune alerte, attente effacee"); raz();
// 8. degrade -> priorite haute
reponses["https://prod/api/sante"] = DEG; await tick("2026-09-19T11:16:00Z"); await tick("2026-09-19T11:17:00Z");
p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "1"); assert.match(p[0].message, /DEGRADE/); assert.match(p[0].message, /courriel indisponible/); ok("degrade : priorite haute, cause courriel"); raz();
reponses["https://prod/api/sante"] = OK; await tick("2026-09-19T11:18:00Z"); await tick("2026-09-19T11:19:00Z"); raz();
// 9. test : sonde aux multiples de 5 seulement, priorite 0
reponses["https://test/api/sante"] = "reseau";
await tick("2026-09-19T11:21:00Z"); assert.equal(appels.filter((a) => a.url.startsWith("https://test")).length, 0); ok("test : pas sonde hors multiples de 5"); raz();
await tick("2026-09-19T11:25:00Z"); await tick("2026-09-19T11:31:00Z"); await tick("2026-09-19T11:35:00Z"); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "0"); assert.match(p[0].title, /test/); assert.match(p[0].message, /INJOIGNABLE/); ok("test : alerte apres 2 sondes, priorite normale"); raz();
await tick("2026-09-19T13:40:00Z"); assert.equal(pushs().length, 0); ok("test : pas de rappel horaire"); raz();
// 10. Pushover en panne : l'etat n'est pas ecrit, la minute suivante reessaie
reponses["https://prod/api/sante"] = KO; await tick("2026-09-19T13:41:00Z");
globalThis.PUSHOVER_KO = true; await assert.rejects(tick("2026-09-19T13:42:00Z"), /Pushover refuse/); assert.equal(ligne("SELECT verdict FROM etat WHERE env='production'").verdict, "ok"); raz();
globalThis.PUSHOVER_KO = false; await tick("2026-09-19T13:43:00Z"); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "2"); assert.equal(ligne("SELECT verdict FROM etat WHERE env='production'").verdict, "hors_service"); ok("Pushover en echec : invocation en echec, reessai la minute suivante"); raz();
// 11. classification des reponses
reponses["https://x/"] = { status: 500, corps: { erreur: "x" } }; assert.equal((await sonder("https://x/")).verdict, "injoignable");
reponses["https://x/"] = { status: 200, corps: { etat: "hors service" } }; assert.equal((await sonder("https://x/")).verdict, "hors_service");
reponses["https://x/"] = "timeout"; const s = await sonder("https://x/"); assert.equal(s.verdict, "injoignable"); assert.match(s.detail, /10 s/); ok("classification des reponses");
// 12. mesures horaires et journal des transitions
const m = ligne("SELECT SUM(n) AS n, SUM(ko) AS ko FROM mesures WHERE env='production'");
assert.ok(m.n === 22 && m.ko === 10, JSON.stringify(m)); // 22 passages simules, dont 10 non ok (4 panne, 1 delai, 2 degrade, 3 panne)
const tr = db.prepare("SELECT de, vers FROM transitions WHERE env='production' ORDER BY id").all().map((x) => `${x.de}>${x.vers}`);
assert.deepEqual(tr, ["ok>hors_service", "hors_service>ok", "ok>degrade", "degrade>ok", "ok>hors_service"]); ok("mesures horaires et transitions journalisees");
reponses["https://prod/api/sante"] = OK; await tick("2026-09-19T13:44:00Z"); await tick("2026-09-19T13:45:00Z"); raz();

// 13. /signal : ferme sans jeton, refuse un mauvais jeton, une forme invalide
assert.equal((await signal({ env: "production", type: "tache", nom: "purges", ok: true }, "x", undefined, { ...env, VIGIE_SIGNAL_JETON: "" })).status, 404);
assert.equal((await signal({ env: "production", type: "tache", nom: "purges", ok: true }, "faux")).status, 401);
assert.equal((await signal({ env: "prod", type: "tache", nom: "purges", ok: true })).status, 400);
assert.equal((await signal({ env: "production", type: "tache", nom: "Purges !", ok: true })).status, 400);
assert.equal((await signal({ env: "production", type: "tache", nom: "purges", ok: "oui" })).status, 400);
assert.equal(pushs().length, 0); ok("/signal : 404 sans jeton configure, 401, 400 sur forme invalide"); raz();
// 14. taches : premier signe de vie silencieux, echec alerte, rafale contenue, retour
assert.equal((await signal({ env: "production", type: "tache", nom: "purges", ok: true, detail: "rien" }, undefined, "2026-09-19T03:00:00Z")).status, 204);
assert.equal(pushs().length, 0);
await signal({ env: "production", type: "tache", nom: "sauvegardes", ok: false, detail: "centre X : echec" }, undefined, "2026-09-19T10:00:00Z");
p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "1"); assert.match(p[0].message, /« sauvegardes » a echoue a 12:00/); raz();
await signal({ env: "production", type: "tache", nom: "sauvegardes", ok: false }, undefined, "2026-09-19T10:30:00Z"); assert.equal(pushs().length, 0);
await signal({ env: "production", type: "tache", nom: "sauvegardes", ok: false }, undefined, "2026-09-19T11:05:00Z");
p = pushs(); assert.equal(p.length, 1); assert.match(p[0].message, /3 fois/); raz();
await signal({ env: "production", type: "tache", nom: "sauvegardes", ok: true }, undefined, "2026-09-19T16:00:00Z");
p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "0"); assert.match(p[0].message, /de nouveau reussi/); ok("taches : echec alerte, rafale contenue a 1/h, retour annonce"); raz();
// 15. une tache muette : alerte a la minute 30, rappel 6 h plus tard seulement, reprise annoncee
await tick("2026-09-20T05:30:00Z"); p = pushs(); assert.equal(p.length, 1); assert.match(p[0].message, /« purges » n'a pas tourne depuis 26 h 30/); raz();
await tick("2026-09-20T06:30:00Z"); assert.equal(pushs().filter((x) => /purges/.test(x.message)).length, 0); raz();
await tick("2026-09-20T11:30:00Z"); assert.equal(pushs().filter((x) => /purges/.test(x.message)).length, 1); raz();
await signal({ env: "production", type: "tache", nom: "purges", ok: true }, undefined, "2026-09-20T12:00:00Z");
p = pushs(); assert.equal(p.length, 1); assert.match(p[0].message, /« purges » a repris/); ok("tache muette : alerte, rappel a 6 h, reprise annoncee"); raz();
// 16. anomalie du test : priorite normale
await signal({ env: "test", type: "anomalie", nom: "courriel", ok: false, detail: "envoi refuse" }, undefined, "2026-09-20T12:00:00Z");
p = pushs(); assert.equal(p[0].priority, "0"); assert.match(p[0].message, /Anomalie « courriel »/); ok("anomalie du test : priorite normale"); raz();
// 17. echeances : domaine dans 20 j -> alerte hebdomadaire puis quotidienne ; RDAP en panne -> derniere lecture
rdap.date = "2026-10-10";
await verifierEcheances(env, new Date("2026-09-20T06:00:00Z")); p = pushs(); assert.equal(p.length, 1); assert.equal(p[0].priority, "1"); assert.match(p[0].message, /cursusconnect.com : expire dans 19 jour/); raz();
await verifierEcheances(env, new Date("2026-09-21T06:00:00Z")); assert.equal(pushs().length, 0); raz();
await verifierEcheances(env, new Date("2026-09-27T06:00:00Z")); assert.equal(pushs().length, 1); raz();
await verifierEcheances(env, new Date("2026-10-04T06:00:00Z")); assert.equal(pushs().length, 1); raz();
await verifierEcheances(env, new Date("2026-10-05T06:00:00Z")); assert.equal(pushs().length, 1); raz();
rdap.ko = true; await verifierEcheances(env, new Date("2026-10-06T06:00:00Z")); p = pushs(); assert.equal(p.length, 1); assert.match(p[0].message, /expire dans 3 jour/); rdap.ko = false; raz(); // 10.10 00:00 - 06.10 06:00 = 3,75 j
assert.equal(ligne("SELECT COUNT(*) AS c FROM echeances").c, 3); ok("echeances : preavis 30 j, hebdomadaire puis quotidien, RDAP en panne tolere"); raz();
// 18. tableau de bord : ferme, protege, echappe
const req = (auth) => new Request("https://vigie/", { headers: auth ? { Authorization: auth } : {} });
assert.equal((await tableau(req(), { ...env, VIGIE_TABLEAU_MDP: "" }, new Date("2026-09-20T12:00:00Z"))).status, 404);
let r = await tableau(req(), env, new Date("2026-09-20T12:00:00Z")); assert.equal(r.status, 401); assert.match(r.headers.get("WWW-Authenticate"), /Basic/);
r = await tableau(req("Basic " + btoa("lsd:faux")), env, new Date("2026-09-20T12:00:00Z")); assert.equal(r.status, 401);
await signal({ env: "test", type: "anomalie", nom: "stockage", ok: false, detail: "<script>alert(1)</script>" }, undefined, "2026-09-20T12:05:00Z");
r = await tableau(req("Basic " + btoa("lsd:mdp")), env, new Date("2026-09-20T12:10:00Z")); assert.equal(r.status, 200);
const html = await r.text(); assert.match(html, /production/); assert.match(html, /Échéances/); assert.match(html, /cursusconnect.com/); assert.match(html, /purges/);
assert.ok(!html.includes("<script>alert(1)</script>") && html.includes("&lt;script&gt;")); assert.equal(r.headers.get("Cache-Control"), "no-store");
ok("tableau : 404 sans mot de passe, 401 sinon, contenu echappe, jamais en cache"); raz();
// 19. fetch : routes inconnues en 404
assert.equal((await w.fetch(new Request("https://vigie/autre"), env)).status, 404); ok("fetch : route inconnue en 404");
// 20. preuve de vie et menage a 06:00 : mesures de plus de 7 jours effacees
db.prepare("INSERT INTO mesures (env, heure, n, ko, ms_total, ms_max) VALUES ('production', '2026-09-01T00:00Z', 1, 0, 100, 100)").run();
await tick("2026-09-21T06:00:00Z"); p = pushs().filter((x) => x.priority === "-2"); assert.equal(p.length, 1); assert.match(p[0].message, /Production : en service/);
assert.equal(ligne("SELECT COUNT(*) AS c FROM mesures WHERE heure < '2026-09-10'").c, 0); ok("preuve de vie muette, menage des mesures"); raz();
// 21. abonnement : CORS, fermeture sans cle, forme d'adresse, double consentement
const reqAb = (chemin, methode = "GET", corps) => new Request("https://vigie.test" + chemin, { method: methode,
  headers: { "Content-Type": "application/json", Origin: "https://status.cursusconnect.com" }, body: corps === undefined ? undefined : JSON.stringify(corps) });
const ab = (chemin, methode, corps, iso, e = env) => abonnement(reqAb(chemin, methode, corps), e, new Date(iso));
let rep = await ab("/abonnement", "OPTIONS", undefined, "2026-09-21T07:01:00Z");
assert.equal(rep.status, 204); assert.equal(rep.headers.get("Access-Control-Allow-Origin"), "https://status.cursusconnect.com");
assert.equal((await ab("/abonnement", "POST", { email: "a@b.fr" }, "2026-09-21T07:01:00Z", { ...env, SCW_TEM_CLE: "" })).status, 503);
assert.equal((await ab("/abonnement", "POST", { email: "pas une adresse" }, "2026-09-21T07:01:00Z")).status, 400);
raz(); rep = await ab("/abonnement", "POST", { email: "Directrice@CHU-Exemple.fr" }, "2026-09-21T07:01:00Z");
assert.equal(rep.status, 202); let mm = tems(); assert.equal(mm.length, 1);
assert.equal(mm[0].to[0].email, "directrice@chu-exemple.fr"); assert.equal(mm[0].project_id, "projet-1"); assert.match(mm[0].subject, /confirmez/);
const jeton = /confirmer\?j=([0-9a-f]{48})/.exec(mm[0].text)[1];
assert.equal(ligne("SELECT etat FROM abonnes WHERE email = 'directrice@chu-exemple.fr'").etat, "en_attente");
assert.ok(mm[0].additional_headers.some((h) => h.key === "Reply-To"));
raz(); await ab("/abonnement", "POST", { email: "directrice@chu-exemple.fr" }, "2026-09-21T07:05:00Z"); assert.equal(tems().length, 0);
raz(); await ab("/abonnement", "POST", { email: "directrice@chu-exemple.fr" }, "2026-09-21T07:12:00Z"); mm = tems(); assert.equal(mm.length, 1);
assert.ok(mm[0].text.includes(jeton), "meme jeton a la relance");
ok("abonnement : CORS, 503 sans cle, 400 sur forme, confirmation envoyee, relance limitee a 10 min"); raz();
// 22. confirmation par BOUTON : un antivirus qui suit le lien ne confirme rien
rep = await ab(`/abonnement/confirmer?j=${jeton}`, "GET", undefined, "2026-09-21T07:13:00Z");
assert.equal(rep.status, 200); assert.match(await rep.text(), /<form method="post">/); assert.equal(ligne("SELECT etat FROM abonnes").etat, "en_attente");
assert.match(rep.headers.get("Content-Security-Policy"), /form-action 'self'/);
rep = await ab(`/abonnement/confirmer?j=${jeton}`, "POST", undefined, "2026-09-21T07:14:00Z");
assert.equal(rep.status, 200); assert.equal(ligne("SELECT etat FROM abonnes").etat, "actif");
assert.equal((await ab("/abonnement/confirmer?j=faux", "GET", undefined, "2026-09-21T07:14:00Z")).status, 404);
raz(); await ab("/abonnement", "POST", { email: "directrice@chu-exemple.fr" }, "2026-09-21T07:40:00Z"); assert.equal(tems().length, 0);
ok("confirmation : GET affiche un bouton, POST active, lien faux en 404, abonne actif non relance"); raz();
// 23. une panne de production previent l'abonne, avec desinscription en un clic
reponses["https://prod/api/sante"] = KO; await tick("2026-09-21T08:01:00Z"); await tick("2026-09-21T08:02:00Z");
mm = tems(); assert.equal(mm.length, 1); assert.match(mm[0].subject, /incident en cours/); assert.match(mm[0].text, /Depuis 10:02/);
assert.ok(mm[0].additional_headers.some((h) => h.key === "List-Unsubscribe" && h.value.includes(`desinscrire?j=${jeton}`)));
assert.ok(mm[0].additional_headers.some((h) => h.key === "List-Unsubscribe-Post"));
assert.ok(!/base|503|HTTP/.test(mm[0].text), "aucun detail technique pour le client");
ok("panne de production : l'abonne est prevenu, sans detail technique, desinscription en un clic"); raz();
// 24. rafale : retabli puis nouvelle panne en moins de 10 min -> un seul courriel, le plus recent
reponses["https://prod/api/sante"] = OK; await tick("2026-09-21T08:03:00Z"); await tick("2026-09-21T08:04:00Z"); assert.equal(tems().length, 0);
reponses["https://prod/api/sante"] = KO; await tick("2026-09-21T08:05:00Z"); await tick("2026-09-21T08:06:00Z"); assert.equal(tems().length, 0);
await tick("2026-09-21T08:11:00Z"); assert.equal(tems().length, 0);
await tick("2026-09-21T08:12:00Z"); mm = tems(); assert.equal(mm.length, 1); assert.match(mm[0].subject, /incident en cours/);
reponses["https://prod/api/sante"] = DEG; raz(); await tick("2026-09-21T08:23:00Z"); await tick("2026-09-21T08:24:00Z");
mm = tems(); assert.equal(mm.length, 1); assert.match(mm[0].subject, /dégradé/); assert.match(mm[0].text, /envoi des e-mails/);
reponses["https://prod/api/sante"] = OK; raz(); await tick("2026-09-21T08:35:00Z"); await tick("2026-09-21T08:36:00Z");
mm = tems(); assert.equal(mm.length, 1); assert.match(mm[0].subject, /rétabli/);
ok("rafale fusionnee (un seul courriel, le plus recent), degrade en mots de client, retablissement"); raz();
// 25. le test ne previent jamais les abonnes
reponses["https://test/api/sante"] = "reseau"; await tick("2026-09-21T08:40:00Z"); await tick("2026-09-21T08:45:00Z"); assert.equal(tems().length, 0);
reponses["https://test/api/sante"] = OK; await tick("2026-09-21T08:50:00Z"); await tick("2026-09-21T08:55:00Z"); raz();
ok("test : aucune alerte aux abonnes");
// 26. Scaleway refuse : reessais espaces, abandon signale au PO apres 5 essais
tem.ko = true; reponses["https://prod/api/sante"] = KO; await tick("2026-09-21T09:01:00Z"); await tick("2026-09-21T09:02:00Z");
assert.equal(ligne("SELECT essais FROM envois WHERE genre = 'etat'").essais, 1);
for (const iso of ["2026-09-21T09:08:00Z", "2026-09-21T09:19:00Z", "2026-09-21T09:35:00Z", "2026-09-21T09:56:00Z"]) await tick(iso);
assert.equal(ligne("SELECT statut FROM envois WHERE genre = 'etat'").statut, "abandon");
assert.ok(pushs().some((x) => /apres 5 essais/.test(x.message) && x.priority === "1"));
tem.ko = false; reponses["https://prod/api/sante"] = OK; await tick("2026-09-21T10:01:00Z"); await tick("2026-09-21T10:02:00Z");
ok("Scaleway en echec : 5 essais espaces, puis abandon signale au PO"); raz();
// 27. desinscription : GET = bouton, POST (ou clic de la messagerie) = adresse effacee
rep = await ab(`/abonnement/desinscrire?j=${jeton}`, "GET", undefined, "2026-09-21T10:05:00Z");
assert.match(await rep.text(), /Me désinscrire/); assert.equal(ligne("SELECT COUNT(*) AS c FROM abonnes").c, 1);
rep = await ab(`/abonnement/desinscrire?j=${jeton}`, "POST", undefined, "2026-09-21T10:05:30Z");
assert.equal(rep.status, 200); assert.equal(ligne("SELECT COUNT(*) AS c FROM abonnes").c, 0);
assert.match(await (await ab(`/abonnement/desinscrire?j=${jeton}`, "GET", undefined, "2026-09-21T10:06:00Z")).text(), /Déjà désinscrit/);
ok("desinscription : bouton, puis adresse effacee"); raz();
// 28. RGPD : une inscription jamais confirmee s'efface apres 48 h ; le tableau compte les abonnes
await ab("/abonnement", "POST", { email: "oubli@exemple.fr" }, "2026-09-21T10:10:00Z");
await tick("2026-09-23T06:00:00Z"); assert.equal(ligne("SELECT COUNT(*) AS c FROM abonnes WHERE email = 'oubli@exemple.fr'").c, 1);
await tick("2026-09-24T06:00:00Z"); assert.equal(ligne("SELECT COUNT(*) AS c FROM abonnes WHERE email = 'oubli@exemple.fr'").c, 0);
await ab("/abonnement", "POST", { email: "compte@exemple.fr" }, "2026-09-24T07:00:00Z");
const tb = await (await tableau(new Request("https://vigie/", { headers: { Authorization: "Basic " + btoa("lsd:mdp") } }), env, new Date("2026-09-24T07:01:00Z"))).text();
assert.match(tb, /0 abonné\(s\) actif\(s\) · 1 en attente de confirmation/);
ok("inscription non confirmee effacee apres 48 h ; le tableau compte les abonnes"); raz();

// 29. erreur GitHub n'empeche pas la sonde
globalThis.fetch = (f => async (u, o) => u.startsWith("https://api.github.com") ? new Response("nope", { status: 401 }) : f(u, o))(globalThis.fetch);
await assert.rejects(tick("2026-09-24T12:22:00Z"), /dispatch refuse : HTTP 401/); ok("GitHub en echec : invocation en echec, sonde quand meme faite");
console.log(`banc : ${n} scenarios passes`);
