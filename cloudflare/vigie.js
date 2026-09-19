// Cursus Connect - vigie (Worker Cloudflare). Lot F du chantier sante et alertes.
//
// Chaque minute :
//   1. sonde la production (SONDE_PRODUCTION_URL) et, aux minutes multiples de 5,
//      le test (SONDE_TEST_URL, facultatif) ;
//   2. ne declare un changement d'etat qu'apres CONFIRMATIONS releves identiques
//      d'affilee ; une alerte Pushover par transition, un rappel par heure tant
//      que la panne dure (production seulement) ;
//   3. aux minutes 07, 22, 37, 52, demande a GitHub le releve de releve.yml
//      (workflow_dispatch), qui tient l'historique et la page d'etat ;
//   4. a 06:00 UTC, envoie une preuve de vie muette (priorite -2).
//
// Aucun secret ni adresse dans ce fichier : tout vient des variables du Worker.
//   SONDE_PRODUCTION_URL  texte    bulletin public de la production
//   SONDE_TEST_URL        texte    bulletin du test (absent = pas de sonde test)
//   GITHUB_JETON          secret   jeton fin, depot cursus-connect-etat seul, Actions RW
//   PUSHOVER_JETON        secret   jeton de l'application Pushover
//   PUSHOVER_UTILISATEUR  secret   cle d'utilisateur Pushover
//   ETAT                  D1       base "cursus-connect-vigie" (coherence forte :
//                                  KV est a coherence differee, jusqu'a 60 s, ce qui
//                                  ferait doubler les alertes)
//
// Etats : ok | degrade | hors_service | injoignable. Priorites Pushover, production :
//   hors_service, injoignable -> 2 (urgence : sonne jusqu'a accuse de reception)
//   degrade                   -> 1 (haute : sonne, meme en heures calmes)
//   retour a ok               -> 0 ; rappel horaire tant que ca dure -> 1
//   test : 0 pour tout, sans rappel. Preuve de vie : -2 (muette).

const DEPOT = "lifesupportdistribution/cursus-connect-etat";
const WORKFLOW = "releve.yml";
const BRANCHE = "main";
const MINUTES_DECLENCHEMENT = [7, 22, 37, 52];
const MINUTE_PREUVE_DE_VIE = { h: 6, m: 0 }; // UTC
const CONFIRMATIONS = 2;        // releves identiques d'affilee avant de changer d'etat
const RAPPEL_MS = 60 * 60 * 1000;
const DELAI_SONDE_MS = 10000;
const HISTORIQUE_URL = `https://raw.githubusercontent.com/${DEPOT}/${BRANCHE}/public/historique.json`;
const FUSEAU = "Europe/Paris";

export default {
  async scheduled(controller, env, ctx) {
    const t = new Date(controller.scheduledTime || Date.now());
    const minute = t.getUTCMinutes(), heure = t.getUTCHours();
    const erreurs = [];
    const tache = async (nom, f) => { try { await f(); } catch (e) { console.error(`${nom} : ${e.message}`); erreurs.push(`${nom} : ${e.message}`); } };

    await tache("sonde production", () => surveiller(env, "production", env.SONDE_PRODUCTION_URL, t));
    if (env.SONDE_TEST_URL && minute % 5 === 0) await tache("sonde test", () => surveiller(env, "test", env.SONDE_TEST_URL, t));
    if (MINUTES_DECLENCHEMENT.includes(minute)) await tache("declenchement GitHub", () => declencherReleve(env));
    if (heure === MINUTE_PREUVE_DE_VIE.h && minute === MINUTE_PREUVE_DE_VIE.m) await tache("preuve de vie", () => preuveDeVie(env, t));

    if (erreurs.length) throw new Error(erreurs.join(" | ")); // marque l'invocation en echec dans les journaux
  },

  // Aucune page a servir.
  async fetch() { return new Response("", { status: 404 }); },
};

/* --- 1. sonder ------------------------------------------------------------- */
export async function sonder(url) {
  const debut = Date.now();
  const ctrl = new AbortController(); const minuteur = setTimeout(() => ctrl.abort(), DELAI_SONDE_MS);
  let r, corps;
  try {
    r = await fetch(url, { signal: ctrl.signal, headers: { "Cache-Control": "no-store", "User-Agent": "cursus-connect-vigie" } });
    corps = await r.json();
  } catch (e) {
    clearTimeout(minuteur);
    return { verdict: "injoignable", http: r ? r.status : null, ms: Date.now() - debut, version: null,
             detail: r ? `reponse illisible (HTTP ${r.status})` : (e.name === "AbortError" ? "aucune reponse en 10 s" : "erreur reseau") };
  }
  clearTimeout(minuteur);
  const ms = Date.now() - debut;
  const base = { http: r.status, ms, version: corps.version || null };
  if (r.status === 200 && corps.etat === "ok") return { ...base, verdict: "ok", detail: "" };
  if (corps.etat === "degrade") return { ...base, verdict: "degrade", detail: cause(corps) };
  if (r.status === 503 || corps.etat === "hors service") return { ...base, verdict: "hors_service", detail: cause(corps) };
  return { ...base, verdict: "injoignable", detail: `reponse inattendue (HTTP ${r.status}, etat ${corps.etat || "absent"})` };
}

// Ce qui a casse, d'apres le bulletin public (qui ne contient ni hote ni identifiant).
function cause(c) {
  const l = [];
  if (c.base && c.base !== "ok") l.push(`base ${c.base}`);
  if (c.schema != null && c.schemaRequis != null && c.schema < c.schemaRequis) l.push(`schema ${c.schema}/${c.schemaRequis}`);
  if (c.stockage && c.stockage !== "ok" && c.stockage !== "non configure") l.push(`stockage ${c.stockage}`);
  if (c.cloisonnement && c.cloisonnement !== "actif") l.push(`cloisonnement ${c.cloisonnement}`);
  if (c.messagerie && c.messagerie !== "ok") l.push(`messagerie ${c.messagerie}`);
  return l.join(", ") || "cause non precisee par le bulletin";
}

/* --- 2. suivre l'etat et alerter aux transitions ---------------------------- */
async function surveiller(env, nom, url, t) {
  const releve = await sonder(url);
  const etat = await lireEtat(env, nom);
  const maintenant = t.toISOString();

  if (releve.verdict === etat.verdict) {
    // Rien de neuf. Rappel horaire si la production reste en panne.
    if (etat.en_attente) await ecrireEtat(env, nom, { ...etat, en_attente: null, compte: 0, maj: maintenant });
    if (nom === "production" && etat.verdict !== "ok" && Date.now() - Date.parse(etat.derniere_alerte || 0) >= RAPPEL_MS) {
      await pushover(env, `Cursus Connect - ${nom}`,
        `Toujours ${libelle(etat.verdict)} depuis ${heureLocale(etat.depuis)} (${duree(etat.depuis, maintenant)}). ${releve.detail}`.trim(), 1);
      await ecrireEtat(env, nom, { ...etat, derniere_alerte: maintenant, maj: maintenant });
    }
    return;
  }

  // Verdict different : on le confirme sur plusieurs releves d'affilee.
  const compte = etat.en_attente === releve.verdict ? etat.compte + 1 : 1;
  if (compte < CONFIRMATIONS) {
    console.log(`${nom} : ${releve.verdict} vu ${compte}/${CONFIRMATIONS} (${releve.detail || "-"})`);
    await ecrireEtat(env, nom, { ...etat, en_attente: releve.verdict, compte, maj: maintenant });
    return;
  }

  // Transition confirmee : alerter d'abord, enregistrer ensuite (un echec Pushover
  // laisse l'etat inchange, donc la minute suivante reessaie).
  const priorite = nom === "production" ? ({ ok: 0, degrade: 1 }[releve.verdict] ?? 2) : 0;
  const message = releve.verdict === "ok"
    ? `Retabli a ${heureLocale(maintenant)} apres ${duree(etat.depuis, maintenant)}. Version ${releve.version || "?"}, reponse en ${releve.ms} ms.`
    : `${libelle(releve.verdict).toUpperCase()} depuis ${heureLocale(maintenant)}. ${releve.detail}${releve.http ? ` (HTTP ${releve.http})` : ""}. ${CONFIRMATIONS} releves consecutifs.`;
  await pushover(env, `Cursus Connect - ${nom}`, message, priorite);
  await ecrireEtat(env, nom, { verdict: releve.verdict, depuis: maintenant, en_attente: null, compte: 0,
                               derniere_alerte: maintenant, detail: releve.detail, maj: maintenant });
}

const libelle = (v) => ({ ok: "en service", degrade: "degrade", hors_service: "hors service", injoignable: "injoignable" }[v] || v);
const duree = (a, b) => { const m = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
const heureLocale = (iso) => new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/* --- etat en D1 ------------------------------------------------------------- */
async function lireEtat(env, nom) {
  await env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS etat (env TEXT PRIMARY KEY, verdict TEXT, depuis TEXT,
    en_attente TEXT, compte INTEGER, derniere_alerte TEXT, detail TEXT, maj TEXT)`).run();
  const l = await env.ETAT.prepare("SELECT * FROM etat WHERE env = ?").bind(nom).first();
  return l || { verdict: "ok", depuis: new Date().toISOString(), en_attente: null, compte: 0, derniere_alerte: null, detail: "", maj: null };
}
async function ecrireEtat(env, nom, e) {
  await env.ETAT.prepare(`INSERT INTO etat (env, verdict, depuis, en_attente, compte, derniere_alerte, detail, maj)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(env) DO UPDATE SET verdict = excluded.verdict, depuis = excluded.depuis,
    en_attente = excluded.en_attente, compte = excluded.compte, derniere_alerte = excluded.derniere_alerte,
    detail = excluded.detail, maj = excluded.maj`)
    .bind(nom, e.verdict, e.depuis, e.en_attente, e.compte, e.derniere_alerte, e.detail || "", e.maj).run();
}

/* --- Pushover ---------------------------------------------------------------- */
async function pushover(env, titre, message, priorite) {
  const corps = new URLSearchParams({ token: env.PUSHOVER_JETON, user: env.PUSHOVER_UTILISATEUR, title: titre,
    message: message.slice(0, 1000), priority: String(priorite) });
  if (priorite === 2) { corps.set("retry", "60"); corps.set("expire", "3600"); }
  const r = await fetch("https://api.pushover.net/1/messages.json", { method: "POST", body: corps });
  const rep = await r.json().catch(() => ({}));
  if (!r.ok || rep.status !== 1) throw new Error(`Pushover refuse : HTTP ${r.status} ${JSON.stringify(rep.errors || rep).slice(0, 200)}`);
  console.log(`Pushover : "${titre}" priorite ${priorite} envoye`);
}

/* --- 3. GitHub ----------------------------------------------------------------- */
async function declencherReleve(env) {
  const r = await fetch(`https://api.github.com/repos/${DEPOT}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.GITHUB_JETON}`, "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cursus-connect-vigie", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: BRANCHE }),
  });
  if (!r.ok) throw new Error(`dispatch refuse : HTTP ${r.status} - ${(await r.text()).slice(0, 300)}`);
  console.log(`dispatch accepte : HTTP ${r.status}`);
}

/* --- 4. preuve de vie ------------------------------------------------------------ */
async function preuveDeVie(env, t) {
  const prod = await lireEtat(env, "production");
  const lignes = [`Production : ${libelle(prod.verdict)} depuis ${duree(prod.depuis, t.toISOString())}.`];
  if (env.SONDE_TEST_URL) { const test = await lireEtat(env, "test"); lignes.push(`Test : ${libelle(test.verdict)} depuis ${duree(test.depuis, t.toISOString())}.`); }
  try {
    const h = await (await fetch(HISTORIQUE_URL, { headers: { "Cache-Control": "no-store" } })).json();
    const hier = new Date(t.getTime() - 86400000).toISOString().slice(0, 10);
    const j = h.composants && h.composants.application && h.composants.application.jours && h.composants.application.jours[hier];
    lignes.push(j ? `Hier, GitHub : ${j.n} releves, ${j.ko} au rouge.` : "Hier, GitHub : aucun releve trouve.");
  } catch (e) { lignes.push("Historique GitHub illisible."); }
  await pushover(env, "Cursus Connect - vigie", lignes.join(" "), -2);
}
