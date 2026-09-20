// Cursus Connect - vigie (Worker Cloudflare). Chantier sante et alertes, lots F et V3.
//
// Chaque minute :
//   1. sonde la production (SONDE_PRODUCTION_URL) et, aux minutes multiples de 5,
//      le test (SONDE_TEST_URL, facultatif) ; mesure la duree de reponse ;
//   2. ne declare un changement d'etat qu'apres CONFIRMATIONS releves identiques
//      d'affilee ; une alerte Pushover par transition, un rappel par heure tant
//      que la panne dure (production seulement) ; chaque transition est journalisee ;
//   3. aux minutes 07, 22, 37, 52, demande a GitHub le releve de releve.yml
//      (workflow_dispatch), qui tient l'historique et la page d'etat publique ;
//   4. a la minute 30 de chaque heure, verifie que les taches planifiees du
//      produit ont donne signe de vie (purges, sauvegardes) ;
//   5. a 06:00 UTC, verifie les echeances (cles, jetons, domaine) et envoie une
//      preuve de vie muette.
//
// Et sur demande (fetch) :
//   POST /signal   le produit se signale lui-meme (taches, anomalies) ; jeton Bearer
//   GET  /tableau  le tableau de bord de l'exploitant ; authentification Basic. Pas a la
//                  racine : l'apercu de l'editeur Cloudflare ouvre la racine, et la fenetre
//                  de connexion bloquait tout l'onglet (piege n.33). La racine repond 404.
//   POST /abonnement                 inscription aux alertes d'incident (double consentement)
//   GET|POST /abonnement/confirmer   confirmation (bouton : un antivirus qui suit le lien ne confirme rien)
//   GET|POST /abonnement/desinscrire desinscription en un clic (RFC 8058) ; l'adresse est effacee
//
// Aucun secret ni adresse dans ce fichier : tout vient des variables du Worker.
//   SONDE_PRODUCTION_URL  texte    bulletin public de la production
//   SONDE_TEST_URL        texte    bulletin du test (absent = pas de sonde test)
//   GITHUB_JETON          secret   jeton fin, depot cursus-connect-etat seul, Actions RW
//   PUSHOVER_JETON        secret   jeton de l'application Pushover
//   PUSHOVER_UTILISATEUR  secret   cle d'utilisateur Pushover
//   VIGIE_SIGNAL_JETON    secret   partage avec le produit (Vercel) ; absent = /signal ferme
//   VIGIE_TABLEAU_MDP     secret   mot de passe du tableau de bord ; absent = tableau ferme
//   SCW_TEM_CLE           secret   cle d'API Scaleway (envoi Transactional Email) ; absent = abonnement ferme
//   SCW_PROJET            texte    identifiant du projet Scaleway qui porte le domaine d'envoi
//   ABONNEMENT_EXPEDITEUR texte    adresse d'envoi, sur le domaine verifie (ex. etat@cursusconnect.com)
//   ABONNEMENT_ORIGINE    texte    origine autorisee a inscrire (https://status.cursusconnect.com)
//   VIGIE_URL             texte    adresse publique de la vigie (liens de confirmation et de desinscription)
//   ETAT                  D1       base "cursus-connect-vigie" (coherence forte :
//                                  KV est a coherence differee, jusqu'a 60 s, ce qui
//                                  ferait doubler les alertes)
//
// Etats : ok | degrade | hors_service | injoignable. Priorites Pushover, production :
//   hors_service, injoignable -> 2 (urgence : sonne jusqu'a accuse de reception)
//   degrade, tache en retard ou en echec, anomalie, echeance proche -> 1 (haute)
//   retour a ok -> 0 ; rappel horaire tant que ca dure -> 1
//   test : 0 pour tout, sans rappel. Preuve de vie : -2 (muette).

const DEPOT = "lifesupportdistribution/cursus-connect-etat";
const WORKFLOW = "releve.yml";
const BRANCHE = "main";
const MINUTES_DECLENCHEMENT = [7, 22, 37, 52];
const MINUTE_TACHES = 30;
const MINUTE_PREUVE_DE_VIE = { h: 6, m: 0 }; // UTC
const CONFIRMATIONS = 2;        // releves identiques d'affilee avant de changer d'etat
const RAPPEL_MS = 60 * 60 * 1000;
const DELAI_SONDE_MS = 10000;
const HISTORIQUE_URL = `https://raw.githubusercontent.com/${DEPOT}/${BRANCHE}/public/historique.json`;
const FUSEAU = "Europe/Paris";
const MESURES_JOURS = 7;

// Taches planifiees du produit (vercel.json) : delai au-dela duquel leur silence
// est une anomalie. purges : 03:00 UTC chaque jour. sauvegardes : 10:00 et 16:00
// UTC, le plus long silence normal va de 16:00 a 10:00 (18 h).
const TACHES = { purges: 26, sauvegardes: 20 };
const RAPPEL_TACHE_MS = 6 * 60 * 60 * 1000;
const ANTI_RAFALE_ANOMALIE_MS = 60 * 60 * 1000;

// Echeances connues, sans lien avec une API : a tenir a jour a chaque rotation
// (journal des rotations). Le domaine est lu en direct (RDAP).
const ECHEANCES_FIXES = [
  { cle: "scaleway", nom: "Cle API Scaleway (envoi des e-mails, test et production)", date: "2027-09-16" },
  { cle: "github", nom: "Jeton GitHub de la vigie", date: "2027-09-19" },
];
const DOMAINES = ["cursusconnect.com"];
const PREAVIS_JOURS = 30;

// Abonnement aux alertes d'incident (page d'etat publique). Double consentement :
// rien n'est envoye a une adresse qui n'a pas confirme. File d'envoi en base :
// ENVOIS_PAR_MINUTE courriels par passage (plafonds du plan gratuit de Workers :
// 50 requetes sortantes et 50 requetes D1 par invocation). Une rafale de
// changements d'etat est fusionnee : un abonne recoit au plus un courriel d'etat
// toutes les NOTIF_MIN_MS, portant l'etat le plus recent.
const ENVOIS_PAR_MINUTE = 15;
const NOTIF_MIN_MS = 10 * 60 * 1000;
const RELANCE_CONFIRMATION_MS = 10 * 60 * 1000;
const CONFIRMATIONS_PAR_JOUR = 200;
const ATTENTE_MAX_MS = 48 * 3600000;       // une inscription non confirmee s'efface
const ESSAIS_MAX = 5;
const FORME_EMAIL = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[a-z]{2,}$/i;
const PAGE_ETAT = "https://status.cursusconnect.com";
const REPONSE_SUPPORT = "support@lifesupportdistribution.fr";

export default {
  async scheduled(controller, env, ctx) {
    const t = new Date(controller.scheduledTime || Date.now());
    const minute = t.getUTCMinutes(), heure = t.getUTCHours();
    const erreurs = [];
    const tache = async (nom, f) => { try { await f(); } catch (e) { console.error(`${nom} : ${e.message}`); erreurs.push(`${nom} : ${e.message}`); } };

    await tache("schema", () => preparer(env));
    await tache("sonde production", () => surveiller(env, "production", env.SONDE_PRODUCTION_URL, t));
    if (env.SONDE_TEST_URL && minute % 5 === 0) await tache("sonde test", () => surveiller(env, "test", env.SONDE_TEST_URL, t));
    if (MINUTES_DECLENCHEMENT.includes(minute)) await tache("declenchement GitHub", () => declencherReleve(env));
    if (minute === MINUTE_TACHES) await tache("taches planifiees", () => verifierTaches(env, t));
    await tache("envois", () => traiterEnvois(env, t));
    if (heure === MINUTE_PREUVE_DE_VIE.h && minute === MINUTE_PREUVE_DE_VIE.m) {
      await tache("echeances", () => verifierEcheances(env, t));
      await tache("preuve de vie", () => preuveDeVie(env, t));
      await tache("menage", () => menage(env, t));
    }

    if (erreurs.length) throw new Error(erreurs.join(" | ")); // marque l'invocation en echec dans les journaux
  },

  async fetch(requete, env) {
    const url = new URL(requete.url);
    try {
      if (url.pathname === "/signal" && requete.method === "POST") return await recevoirSignal(requete, env, new Date());
      if (url.pathname.startsWith("/abonnement")) return await abonnement(requete, env, new Date());
      if (url.pathname === "/tableau" && requete.method === "GET") return await tableau(requete, env, new Date());
    } catch (e) {
      console.error(`fetch ${url.pathname} : ${e.message}`);
      return new Response("", { status: 500 });
    }
    return new Response("", { status: 404 });
  },
};

/* --- schema D1 (cree a la premiere invocation, sans migration a jouer) ------ */
let _prepare = false;
async function preparer(env) {
  if (_prepare) return;
  await env.ETAT.batch([
    env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS etat (env TEXT PRIMARY KEY, verdict TEXT, depuis TEXT,
      en_attente TEXT, compte INTEGER, derniere_alerte TEXT, detail TEXT, maj TEXT)`),
    env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS transitions (id INTEGER PRIMARY KEY AUTOINCREMENT,
      env TEXT, de TEXT, vers TEXT, t TEXT, detail TEXT)`),
    env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS mesures (env TEXT, heure TEXT, n INTEGER, ko INTEGER,
      ms_total INTEGER, ms_max INTEGER, PRIMARY KEY (env, heure))`),
    env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS signaux (cle TEXT PRIMARY KEY, env TEXT, type TEXT, nom TEXT,
      ok INTEGER, detail TEXT, t TEXT, derniere_alerte TEXT, compte INTEGER)`),
    env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS echeances (cle TEXT PRIMARY KEY, nom TEXT, date TEXT,
      source TEXT, verifie TEXT, derniere_alerte TEXT)`),
    env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS abonnes (email TEXT PRIMARY KEY, jeton TEXT UNIQUE, etat TEXT,
      cree TEXT, confirme TEXT, derniere_demande TEXT)`),
    env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS envois (id INTEGER PRIMARY KEY AUTOINCREMENT, genre TEXT,
      email TEXT, jeton TEXT, sujet TEXT, texte TEXT, html TEXT, apres TEXT, essais INTEGER DEFAULT 0,
      statut TEXT DEFAULT 'a_envoyer', erreur TEXT)`),
    env.ETAT.prepare(`CREATE TABLE IF NOT EXISTS compteurs (cle TEXT PRIMARY KEY, n INTEGER, valeur TEXT)`),
  ]);
  _prepare = true;
}

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
  if (c.stockage && c.stockage !== "ok") l.push(`stockage ${c.stockage}`);
  if (c.cloisonnement && c.cloisonnement !== "actif") l.push(`cloisonnement ${c.cloisonnement}`);
  if (c.courriel && c.courriel !== "ok") l.push(`courriel ${c.courriel}`); // [1.575.0]
  if (c.tls && c.tls !== "ca_fournie") l.push(`tls ${c.tls}`);
  return l.join(", ") || "cause non precisee par le bulletin";
}

/* --- 2. suivre l'etat et alerter aux transitions ---------------------------- */
async function surveiller(env, nom, url, t) {
  const releve = await sonder(url);
  await mesurer(env, nom, t, releve);
  const etat = await lireEtat(env, nom);
  const maintenant = t.toISOString();

  if (releve.verdict === etat.verdict) {
    // Rien de neuf. Rappel horaire si la production reste en panne.
    if (etat.en_attente) await ecrireEtat(env, nom, { ...etat, en_attente: null, compte: 0, maj: maintenant });
    if (nom === "production" && etat.verdict !== "ok" && t.getTime() - Date.parse(etat.derniere_alerte || 0) >= RAPPEL_MS) {
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
  await env.ETAT.prepare("INSERT INTO transitions (env, de, vers, t, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(nom, etat.verdict, releve.verdict, maintenant, releve.detail || "").run();
  if (nom === "production") await notifierAbonnes(env, etat, releve, t);
}

// Une ligne par heure et par environnement : nombre de releves, releves non ok,
// durees. Sept jours gardes : de quoi voir une lenteur s'installer.
async function mesurer(env, nom, t, releve) {
  const heure = t.toISOString().slice(0, 13) + ":00Z";
  const ko = releve.verdict === "ok" ? 0 : 1;
  await env.ETAT.prepare(`INSERT INTO mesures (env, heure, n, ko, ms_total, ms_max) VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(env, heure) DO UPDATE SET n = n + 1, ko = ko + excluded.ko,
    ms_total = ms_total + excluded.ms_total, ms_max = MAX(ms_max, excluded.ms_max)`)
    .bind(nom, heure, ko, releve.ms || 0, releve.ms || 0).run();
}

const libelle = (v) => ({ ok: "en service", degrade: "degrade", hors_service: "hors service", injoignable: "injoignable" }[v] || v);
const duree = (a, b) => { const m = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
const heureLocale = (iso) => new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const dateLocale = (iso) => new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));

/* --- etat en D1 ------------------------------------------------------------- */
async function lireEtat(env, nom) {
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

/* --- signaux du produit ---------------------------------------------------------- */
// Le produit se signale lui-meme : une tache planifiee qui se termine (ok ou non),
// une anomalie vue en usage reel (un courriel refuse...). Le jeton est partage avec
// Vercel ; comparaison a temps constant. Rien de ce qui arrive ici n'est cru sur
// parole au-dela de sa forme : environnement connu, nom court, detail tronque.
const FORME_NOM = /^[a-z0-9_-]{1,40}$/;
export async function recevoirSignal(requete, env, t) {
  const attendu = env.VIGIE_SIGNAL_JETON || "";
  if (!attendu) return new Response("", { status: 404 });
  const recu = (requete.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!egal(recu, attendu)) return new Response("", { status: 401 });
  let s; try { s = await requete.json(); } catch { return new Response("", { status: 400 }); }
  const envNom = s && s.env, type = s && s.type, nom = s && s.nom;
  if (!["production", "test"].includes(envNom) || !["tache", "anomalie"].includes(type) || !FORME_NOM.test(nom || "")
      || typeof s.ok !== "boolean") return new Response("", { status: 400 });
  const detail = String(s.detail || "").replace(/[\r\n]+/g, " ").slice(0, 300);
  await preparer(env);
  const cle = `${envNom}:${type}:${nom}`;
  const avant = await env.ETAT.prepare("SELECT * FROM signaux WHERE cle = ?").bind(cle).first();
  const maintenant = t.toISOString();
  let derniereAlerte = avant ? avant.derniere_alerte : null;
  let compte = avant ? avant.compte || 0 : 0;
  const priorite = envNom === "production" ? 1 : 0;
  const titre = `Cursus Connect - ${envNom}`;

  if (!s.ok) {
    compte = avant && !avant.ok ? compte + 1 : 1;
    // Premiere occurrence : alerte tout de suite. Ensuite, une par heure au plus.
    const silence = derniereAlerte && avant && !avant.ok && t.getTime() - Date.parse(derniereAlerte) < ANTI_RAFALE_ANOMALIE_MS;
    if (!silence) {
      const quoi = type === "tache" ? `La tache planifiee « ${nom} » a echoue` : `Anomalie « ${nom} »`;
      await pushover(env, titre, `${quoi} a ${heureLocale(maintenant)}${compte > 1 ? ` (${compte} fois depuis la premiere alerte)` : ""}. ${detail}`.trim(), priorite);
      derniereAlerte = maintenant;
    }
  } else if (avant && !avant.ok) {
    const quoi = type === "tache" ? `La tache planifiee « ${nom} » a de nouveau reussi` : `Anomalie « ${nom} » resolue`;
    await pushover(env, titre, `${quoi} a ${heureLocale(maintenant)}.`, 0);
    derniereAlerte = null; compte = 0;
  } else if (avant && avant.derniere_alerte && type === "tache") {
    // Une tache qui avait ete signalee en retard vient de repasser.
    await pushover(env, titre, `La tache planifiee « ${nom} » a repris a ${heureLocale(maintenant)}.`, 0);
    derniereAlerte = null;
  }
  await env.ETAT.prepare(`INSERT INTO signaux (cle, env, type, nom, ok, detail, t, derniere_alerte, compte)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cle) DO UPDATE SET ok = excluded.ok, detail = excluded.detail,
    t = excluded.t, derniere_alerte = excluded.derniere_alerte, compte = excluded.compte`)
    .bind(cle, envNom, type, nom, s.ok ? 1 : 0, detail, maintenant, derniereAlerte, compte).run();
  return new Response(null, { status: 204 }); // 204 : corps nul exige (un corps vide "" leve une erreur)
}

function egal(a, b) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let d = 0; for (let i = 0; i < ea.length; i++) d |= ea[i] ^ eb[i];
  return d === 0;
}

/* --- 4. taches planifiees : leur silence est une anomalie ------------------------- */
// On ne surveille une tache qu'apres son premier signe de vie : pas de fausse alerte
// le jour ou le produit apprend a se signaler.
async function verifierTaches(env, t) {
  const { results } = await env.ETAT.prepare("SELECT * FROM signaux WHERE type = 'tache'").all();
  for (const s of results || []) {
    const maxH = TACHES[s.nom]; if (!maxH) continue;
    const silenceMs = t.getTime() - Date.parse(s.t);
    if (silenceMs < maxH * 3600000) continue;
    if (s.derniere_alerte && t.getTime() - Date.parse(s.derniere_alerte) < RAPPEL_TACHE_MS) continue;
    await pushover(env, `Cursus Connect - ${s.env}`,
      `La tache planifiee « ${s.nom} » n'a pas tourne depuis ${duree(s.t, t.toISOString())} (attendu : moins de ${maxH} h).`,
      s.env === "production" ? 1 : 0);
    await env.ETAT.prepare("UPDATE signaux SET derniere_alerte = ? WHERE cle = ?").bind(t.toISOString(), s.cle).run();
  }
}

/* --- 5. echeances -------------------------------------------------------------------- */
async function echeanceDomaine(domaine) {
  const r = await fetch(`https://rdap.org/domain/${domaine}`, { headers: { Accept: "application/rdap+json" } });
  if (!r.ok) throw new Error(`RDAP ${domaine} : HTTP ${r.status}`);
  const d = await r.json();
  const e = (d.events || []).find((x) => x.eventAction === "expiration");
  if (!e) throw new Error(`RDAP ${domaine} : pas de date d'expiration`);
  return e.eventDate.slice(0, 10);
}
export async function verifierEcheances(env, t) {
  const liste = ECHEANCES_FIXES.map((e) => ({ ...e, source: "journal des rotations" }));
  for (const d of DOMAINES) {
    try { liste.push({ cle: `domaine:${d}`, nom: `Nom de domaine ${d}`, date: await echeanceDomaine(d), source: "RDAP" }); }
    catch (e) {
      const connu = await env.ETAT.prepare("SELECT * FROM echeances WHERE cle = ?").bind(`domaine:${d}`).first();
      if (connu) liste.push({ ...connu, source: "RDAP (derniere lecture)" });
      console.error(e.message);
    }
  }
  for (const e of liste) {
    const jours = Math.floor((Date.parse(e.date + "T00:00:00Z") - t.getTime()) / 86400000);
    const connu = await env.ETAT.prepare("SELECT derniere_alerte FROM echeances WHERE cle = ?").bind(e.cle).first();
    let derniere = connu ? connu.derniere_alerte : null;
    if (jours <= PREAVIS_JOURS) {
      // Une fois par semaine au-dela de 7 jours, chaque jour ensuite.
      const periode = (jours <= 7 ? 1 : 7) * 86400000 - 3600000;
      if (!derniere || t.getTime() - Date.parse(derniere) >= periode) {
        await pushover(env, "Cursus Connect - echeance",
          jours < 0 ? `${e.nom} : ECHUE depuis ${-jours} jour(s) (${dateLocale(e.date)}).`
                    : `${e.nom} : expire dans ${jours} jour(s), le ${dateLocale(e.date)}. A renouveler.`, 1);
        derniere = t.toISOString();
      }
    } else derniere = null;
    await env.ETAT.prepare(`INSERT INTO echeances (cle, nom, date, source, verifie, derniere_alerte) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cle) DO UPDATE SET nom = excluded.nom, date = excluded.date, source = excluded.source,
      verifie = excluded.verifie, derniere_alerte = excluded.derniere_alerte`)
      .bind(e.cle, e.nom, e.date, e.source, t.toISOString(), derniere).run();
  }
}

/* --- preuve de vie, menage ------------------------------------------------------------ */
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
async function menage(env, t) {
  const limite = new Date(t.getTime() - MESURES_JOURS * 86400000).toISOString().slice(0, 13) + ":00Z";
  await env.ETAT.prepare("DELETE FROM mesures WHERE heure < ?").bind(limite).run();
  await env.ETAT.prepare("DELETE FROM transitions WHERE id NOT IN (SELECT id FROM transitions ORDER BY id DESC LIMIT 200)").run();
  // RGPD : une inscription jamais confirmee ne se garde pas ; un envoi abandonne non plus.
  await env.ETAT.prepare("DELETE FROM abonnes WHERE etat = 'en_attente' AND cree < ?")
    .bind(new Date(t.getTime() - ATTENTE_MAX_MS).toISOString()).run();
  await env.ETAT.prepare("DELETE FROM envois WHERE statut = 'abandon' AND apres < ?")
    .bind(new Date(t.getTime() - 7 * 86400000).toISOString()).run();
}

/* --- tableau de bord ------------------------------------------------------------------- */
// Il vit ICI et non dans le produit : le jour ou le produit tombe, c'est la que
// l'exploitant regarde. Authentification Basic (utilisateur « lsd »), mot de passe
// en secret du Worker, comparaison a temps constant ; sans mot de passe configure,
// la page n'existe pas.
export async function tableau(requete, env, t) {
  const mdp = env.VIGIE_TABLEAU_MDP || "";
  if (!mdp) return new Response("", { status: 404 });
  const auth = requete.headers.get("Authorization") || "";
  let ok = false;
  if (auth.startsWith("Basic ")) {
    try { ok = egal(atob(auth.slice(6)), `lsd:${mdp}`); } catch { ok = false; }
  }
  if (!ok) return new Response("Authentification requise", { status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Cursus Connect - vigie", charset="UTF-8"' } });
  await preparer(env);
  const q = async (sql, ...b) => (await env.ETAT.prepare(sql).bind(...b).all()).results || [];
  const etats = await q("SELECT * FROM etat ORDER BY env");
  const depuis24 = new Date(t.getTime() - 24 * 3600000).toISOString().slice(0, 13) + ":00Z";
  const mesures = await q("SELECT * FROM mesures WHERE heure >= ? ORDER BY env, heure", depuis24);
  const transitions = await q("SELECT * FROM transitions ORDER BY id DESC LIMIT 20");
  const signaux = await q("SELECT * FROM signaux ORDER BY env, type, nom");
  const echeances = await q("SELECT * FROM echeances ORDER BY date");
  const abonnes = (await q("SELECT etat, COUNT(*) AS n FROM abonnes GROUP BY etat"))
    .reduce((a, x) => ({ ...a, [x.etat]: x.n }), {});
  const file = (await q("SELECT statut, COUNT(*) AS n FROM envois GROUP BY statut"))
    .reduce((a, x) => ({ ...a, [x.statut]: x.n }), {});
  return new Response(pageTableau({ t, etats, mesures, transitions, signaux, echeances, abonnes, file }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
               "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" } });
}

const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COULEUR = { ok: "#1d7a46", degrade: "#b7791f", hors_service: "#b3261e", injoignable: "#b3261e" };
const dateHeure = (iso) => iso ? new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "-";

/** @param {{ t: Date, etats: any[], mesures: any[], transitions: any[], signaux: any[], echeances: any[],
 *   abonnes?: Record<string, number>, file?: Record<string, number> }} p */
export function pageTableau({ t, etats, mesures, transitions, signaux, echeances, abonnes = {}, file = {} }) {
  const carte = (e) => {
    const m = mesures.filter((x) => x.env === e.env);
    const n = m.reduce((a, x) => a + x.n, 0), ko = m.reduce((a, x) => a + x.ko, 0);
    const moy = n ? Math.round(m.reduce((a, x) => a + x.ms_total, 0) / n) : 0;
    const max = m.reduce((a, x) => Math.max(a, x.ms_max), 0);
    const barres = m.map((x) => `<span title="${echapper(dateHeure(x.heure))} : ${x.n} relevés, ${x.ko} en défaut, ${Math.round(x.ms_total / x.n)} ms" style="background:${x.ko ? "#b3261e" : "#1d7a46"};opacity:${x.ko ? 1 : 0.35 + Math.min(0.65, x.ms_total / x.n / 3000)}"></span>`).join("");
    return `<section class="carte"><h2>${echapper(e.env)}</h2>
      <p class="verdict" style="color:${COULEUR[e.verdict] || "#444"}">${echapper(libelle(e.verdict))}</p>
      <p>depuis ${echapper(dateHeure(e.depuis))}${e.detail ? ` — ${echapper(e.detail)}` : ""}${e.en_attente ? ` · <b>${echapper(e.en_attente)} en confirmation</b>` : ""}</p>
      <p>24 h : ${n} relevés, ${ko} en défaut · réponse moyenne ${moy} ms, pire ${max} ms</p>
      <div class="barres">${barres}</div></section>`;
  };
  const ligneSignal = (s) => {
    const maxH = s.type === "tache" ? TACHES[s.nom] : null;
    const enRetard = maxH && t.getTime() - Date.parse(s.t) > maxH * 3600000;
    const etat = !s.ok ? "en échec" : enRetard ? "en retard" : "ok";
    return `<tr><td>${echapper(s.env)}</td><td>${echapper(s.type)}</td><td>${echapper(s.nom)}</td>
      <td style="color:${etat === "ok" ? "#1d7a46" : "#b3261e"}">${etat}</td><td>${echapper(dateHeure(s.t))}</td><td>${echapper(s.detail)}</td></tr>`;
  };
  const ligneEcheance = (e) => {
    const j = Math.floor((Date.parse(e.date + "T00:00:00Z") - t.getTime()) / 86400000);
    return `<tr><td>${echapper(e.nom)}</td><td>${echapper(dateLocale(e.date))}</td>
      <td style="color:${j <= PREAVIS_JOURS ? "#b3261e" : "#1d7a46"}">${j} j</td><td>${echapper(e.source)}</td></tr>`;
  };
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Cursus Connect — vigie</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f4f6fa;color:#1b1f2a}
header{background:#29327a;color:#fff;padding:14px 20px}header h1{margin:0;font-size:18px}header p{margin:4px 0 0;opacity:.8;font-size:13px}
main{padding:16px 20px;max-width:1100px}.cartes{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.carte,.bloc{background:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 1px 3px #0001;margin-bottom:14px}
h2{margin:0 0 6px;font-size:15px;color:#29327a}.carte h2{text-transform:capitalize}.verdict{font-size:22px;font-weight:700;margin:4px 0}
.barres{display:flex;gap:2px;height:28px;align-items:stretch}.barres span{flex:1;border-radius:2px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:5px 8px;border-bottom:1px solid #e6e9f0}
p{margin:4px 0;font-size:13px}</style></head><body>
<header><h1>Cursus Connect — vigie</h1><p>Mis à jour ${echapper(dateHeure(t.toISOString()))} · page rafraîchie chaque minute · historique public : status.cursusconnect.com</p></header>
<main><div class="cartes">${etats.map(carte).join("") || "<p>Aucun relevé encore.</p>"}</div>
<section class="bloc"><h2>Tâches et signaux du produit</h2>${signaux.length ? `<table><tr><th>Env.</th><th>Type</th><th>Nom</th><th>État</th><th>Dernier signal</th><th>Détail</th></tr>${signaux.map(ligneSignal).join("")}</table>` : "<p>Aucun signal reçu du produit pour l'instant.</p>"}</section>
<section class="bloc"><h2>Abonnés aux alertes d'incident</h2><p>${abonnes.actif || 0} abonné(s) actif(s) · ${abonnes.en_attente || 0} en attente de confirmation · file d'envoi : ${file.a_envoyer || 0} à envoyer${file.abandon ? `, <b style="color:#b3261e">${file.abandon} abandonné(s)</b>` : ""}</p></section>
<section class="bloc"><h2>Échéances</h2>${echeances.length ? `<table><tr><th>Quoi</th><th>Date</th><th>Reste</th><th>Source</th></tr>${echeances.map(ligneEcheance).join("")}</table>` : "<p>Première vérification à 08:00 (Paris).</p>"}</section>
<section class="bloc"><h2>Dernières transitions</h2>${transitions.length ? `<table><tr><th>Quand</th><th>Env.</th><th>De</th><th>Vers</th><th>Détail</th></tr>${transitions.map((x) => `<tr><td>${echapper(dateHeure(x.t))}</td><td>${echapper(x.env)}</td><td>${echapper(libelle(x.de))}</td><td style="color:${COULEUR[x.vers] || "#444"}">${echapper(libelle(x.vers))}</td><td>${echapper(x.detail)}</td></tr>`).join("")}</table>` : "<p>Aucune transition journalisée.</p>"}</section>
</main></body></html>`;
}

/* --- abonnement aux alertes d'incident -------------------------------------------------- */
// Double consentement : l'inscription envoie un lien ; la confirmation se fait par un
// BOUTON (POST), car les antivirus de messagerie suivent les liens et confirmeraient a la
// place du destinataire. Meme regle pour la desinscription, qui accepte aussi le POST
// « en un clic » des messageries (RFC 8058). L'adresse desinscrite est EFFACEE.
// Donnees : l'adresse, deux dates, un jeton. Base D1 en juridiction UE.

function entetesCors(env) {
  return { "Access-Control-Allow-Origin": env.ABONNEMENT_ORIGINE || PAGE_ETAT,
           "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
           "Access-Control-Max-Age": "86400", "Vary": "Origin" };
}
const json = (corps, status, entetes = {}) => new Response(JSON.stringify(corps), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...entetes } });
function jetonAleatoire() {
  const o = new Uint8Array(24); crypto.getRandomValues(o);
  return [...o].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const baseVigie = (env, requete) => env.VIGIE_URL || (requete ? new URL(requete.url).origin : "");

export async function abonnement(requete, env, t) {
  const url = new URL(requete.url);
  const cors = entetesCors(env);
  if (url.pathname === "/abonnement" && requete.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  await preparer(env);
  if (url.pathname === "/abonnement" && requete.method === "POST") return inscrire(requete, env, t, cors);
  const jeton = (url.searchParams.get("j") || "").slice(0, 64);
  if (url.pathname === "/abonnement/confirmer") return confirmer(requete, env, t, jeton);
  if (url.pathname === "/abonnement/desinscrire") return desinscrire(requete, env, t, jeton);
  return new Response("", { status: 404 });
}

async function inscrire(requete, env, t, cors) {
  if (!env.SCW_TEM_CLE || !env.SCW_PROJET || !env.ABONNEMENT_EXPEDITEUR) return json({ ok: false, err: "ferme" }, 503, cors);
  let corps; try { corps = await requete.json(); } catch { return json({ ok: false, err: "corps" }, 400, cors); }
  const email = String(corps && corps.email || "").trim().toLowerCase();
  if (!FORME_EMAIL.test(email) || email.length > 254) return json({ ok: false, err: "adresse" }, 400, cors);
  const jour = t.toISOString().slice(0, 10);
  const c = await env.ETAT.prepare("SELECT n, valeur FROM compteurs WHERE cle = 'confirmations'").first();
  const n = c && c.valeur === jour ? c.n : 0;
  if (n >= CONFIRMATIONS_PAR_JOUR) return json({ ok: false, err: "plafond" }, 429, cors);
  const connu = await env.ETAT.prepare("SELECT * FROM abonnes WHERE email = ?").bind(email).first();
  // Reponse identique dans tous les cas : la page ne revele pas qui est abonne.
  const reponse = json({ ok: true }, 202, cors);
  if (connu && connu.etat === "actif") return reponse;
  if (connu && connu.derniere_demande && t.getTime() - Date.parse(connu.derniere_demande) < RELANCE_CONFIRMATION_MS) return reponse;
  const jeton = connu ? connu.jeton : jetonAleatoire();
  const maintenant = t.toISOString();
  await env.ETAT.prepare(`INSERT INTO abonnes (email, jeton, etat, cree, confirme, derniere_demande)
    VALUES (?, ?, 'en_attente', ?, NULL, ?) ON CONFLICT(email) DO UPDATE SET derniere_demande = excluded.derniere_demande`)
    .bind(email, jeton, maintenant, maintenant).run();
  await env.ETAT.prepare(`INSERT INTO compteurs (cle, n, valeur) VALUES ('confirmations', ?, ?)
    ON CONFLICT(cle) DO UPDATE SET n = excluded.n, valeur = excluded.valeur`).bind(n + 1, jour).run();
  const lien = `${baseVigie(env, requete)}/abonnement/confirmer?j=${jeton}`;
  const m = courrielConfirmation(lien);
  await env.ETAT.prepare(`INSERT INTO envois (genre, email, jeton, sujet, texte, html, apres) VALUES ('confirmation', ?, ?, ?, ?, ?, ?)`)
    .bind(email, jeton, m.sujet, m.texte, m.html, maintenant).run();
  // Premier essai tout de suite : l'utilisateur attend ce courriel. En cas d'echec,
  // la file le reprend a la minute suivante.
  await traiterEnvois(env, t, 1);
  return reponse;
}

async function confirmer(requete, env, t, jeton) {
  const a = jeton ? await env.ETAT.prepare("SELECT * FROM abonnes WHERE jeton = ?").bind(jeton).first() : null;
  if (!a) return pageHtml("Lien invalide ou expiré", "<p>Ce lien de confirmation n'est plus valable : une inscription non confirmée s'efface au bout de 48 heures. Vous pouvez vous inscrire de nouveau depuis la page d'état.</p>", 404);
  if (a.etat === "actif") return pageHtml("Abonnement actif", `<p>L'adresse <b>${echapper(a.email)}</b> est déjà abonnée aux alertes d'incident de Cursus Connect.</p>`);
  if (requete.method !== "POST") {
    return pageHtml("Confirmer l'abonnement", `<p>Recevoir un courriel à chaque incident de Cursus Connect, et à son rétablissement, à l'adresse <b>${echapper(a.email)}</b> ?</p>
<form method="post"><button type="submit">Confirmer l'abonnement</button></form>`);
  }
  await env.ETAT.prepare("UPDATE abonnes SET etat = 'actif', confirme = ? WHERE jeton = ?").bind(t.toISOString(), jeton).run();
  return pageHtml("Abonnement confirmé", `<p>C'est fait : <b>${echapper(a.email)}</b> sera prévenue de chaque incident de Cursus Connect et de son rétablissement. Chaque courriel contient un lien de désinscription.</p>`);
}

async function desinscrire(requete, env, t, jeton) {
  const a = jeton ? await env.ETAT.prepare("SELECT * FROM abonnes WHERE jeton = ?").bind(jeton).first() : null;
  if (requete.method === "POST") {
    if (a) {
      await env.ETAT.prepare("DELETE FROM abonnes WHERE jeton = ?").bind(jeton).run();
      await env.ETAT.prepare("DELETE FROM envois WHERE jeton = ? AND statut = 'a_envoyer'").bind(jeton).run();
    }
    return pageHtml("Désinscription faite", "<p>Vous ne recevrez plus les alertes d'incident de Cursus Connect. Votre adresse a été effacée.</p>");
  }
  if (!a) return pageHtml("Déjà désinscrit", "<p>Cette adresse ne reçoit pas, ou plus, les alertes d'incident de Cursus Connect.</p>");
  return pageHtml("Se désinscrire", `<p>Ne plus recevoir les alertes d'incident de Cursus Connect à l'adresse <b>${echapper(a.email)}</b> ?</p>
<form method="post"><button type="submit">Me désinscrire</button></form>`);
}

function pageHtml(titre, contenu, status = 200) {
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${echapper(titre)} — Cursus Connect</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f6fa;color:#1b1f2a;margin:0;padding:48px 16px}
main{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 30px;box-shadow:0 1px 3px #0001}
h1{font-size:20px;color:#29327a;margin:0 0 12px}p{line-height:1.5}button{font:inherit;font-weight:600;color:#fff;background:#1a6e9e;
border:0;border-radius:8px;padding:10px 18px;cursor:pointer}a{color:#1a6e9e}</style></head><body><main>
<h1>${echapper(titre)}</h1>${contenu}<p><a href="${PAGE_ETAT}">État des services Cursus Connect</a></p></main></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
}

// Courriels : texte ET HTML, sans image ni suivi.
function gabarit(titre, paragraphes, pied) {
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b1f2a">
<div style="background:#29327a;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-weight:bold">Cursus Connect — état des services</div>
<div style="border:1px solid #e2e7f0;border-top:0;border-radius:0 0 10px 10px;padding:18px 20px">
<h2 style="font-size:17px;color:#29327a;margin:0 0 10px">${echapper(titre)}</h2>
${paragraphes.map((p) => `<p style="line-height:1.5;margin:0 0 10px">${p}</p>`).join("")}
<p style="font-size:12px;color:#646a80;margin-top:18px">${pied}</p></div></div>`;
  return html;
}
const sansBalises = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function courrielConfirmation(lien) {
  const titre = "Confirmez votre abonnement";
  const p = [
    "Vous avez demandé à être prévenu des incidents de Cursus Connect.",
    `Pour activer l'abonnement, ouvrez ce lien puis cliquez sur « Confirmer » : <a href="${echapper(lien)}">${echapper(lien)}</a>`,
    "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : sans confirmation, votre adresse sera effacée sous 48 heures.",
  ];
  const pied = `Life Support Distribution · éditeur de Cursus Connect · <a href="${PAGE_ETAT}">${PAGE_ETAT}</a>`;
  return { sujet: "Cursus Connect — confirmez votre abonnement aux alertes d'incident",
           texte: [titre, "", ...p.map(sansBalises), "", lien].join("\n"), html: gabarit(titre, p, pied) };
}

// Ce que dit un courriel d'etat : l'etat, depuis quand, ce qui est touche - en mots de
// client, jamais un nom de composant interne ni un code d'erreur.
const TOUCHE = { stockage: "le dépôt et la consultation des fichiers", courriel: "l'envoi des e-mails (convocations, invitations, codes de connexion)" };
export function courrielEtat(etatAvant, releve, t) {
  const heure = heureLocale(t.toISOString());
  const touches = Object.entries(TOUCHE).filter(([k]) => (releve.detail || "").includes(k)).map(([, v]) => v);
  let sujet, titre, p;
  if (releve.verdict === "ok") {
    sujet = "Cursus Connect — service rétabli";
    titre = "Le service est rétabli";
    p = [`Cursus Connect fonctionne de nouveau normalement depuis ${heure} (heure de Paris), après ${duree(etatAvant.depuis, t.toISOString())} de perturbation.`,
         "Merci de votre patience."];
  } else if (releve.verdict === "degrade") {
    sujet = "Cursus Connect — service dégradé";
    titre = "Service dégradé";
    p = [`Depuis ${heure} (heure de Paris), Cursus Connect reste accessible, mais ${touches.length ? touches.join(" et ") + (touches.length > 1 ? " sont perturbés" : " est perturbé") : "une de ses fonctions est perturbée"}.`,
         "Nos équipes en ont été prévenues automatiquement et interviennent."];
  } else {
    sujet = "Cursus Connect — incident en cours";
    titre = "Incident en cours";
    p = [`Depuis ${heure} (heure de Paris), Cursus Connect ne répond pas normalement.`,
         "Nos équipes en ont été prévenues automatiquement et interviennent. Vous recevrez un courriel au rétablissement."];
  }
  p.push(`Suivi en direct : <a href="${PAGE_ETAT}">${PAGE_ETAT}</a>`);
  return { sujet, titre, p };
}

// Une transition de production confirmee : un courriel par abonne actif. Une rafale est
// fusionnee : les courriels d'etat pas encore partis sont remplaces par le plus recent,
// et aucun ne part moins de NOTIF_MIN_MS apres le dernier courriel d'etat REELLEMENT
// parti (« derniere_notif », ecrit par la file, pas a la mise en file : sinon chaque
// remplacement repousserait l'envoi d'autant).
async function notifierAbonnes(env, etatAvant, releve, t) {
  if (!env.SCW_TEM_CLE) return;
  const { results } = await env.ETAT.prepare("SELECT email, jeton FROM abonnes WHERE etat = 'actif'").all();
  if (!results || !results.length) return;
  await env.ETAT.prepare("DELETE FROM envois WHERE genre = 'etat' AND statut = 'a_envoyer'").run();
  const dernier = await env.ETAT.prepare("SELECT valeur FROM compteurs WHERE cle = 'derniere_notif'").first();
  const apres = new Date(Math.max(t.getTime(), dernier ? Date.parse(dernier.valeur) + NOTIF_MIN_MS : 0)).toISOString();
  const m = courrielEtat(etatAvant, releve, t);
  const base = baseVigie(env);
  const stmts = results.map((a) => {
    const pied = `Vous recevez ce message parce que vous êtes abonné aux alertes d'incident de Cursus Connect. <a href="${base}/abonnement/desinscrire?j=${a.jeton}">Se désinscrire</a>.`;
    const html = gabarit(m.titre, m.p, pied);
    const texte = [m.titre, "", ...m.p.map(sansBalises), "", `Se désinscrire : ${base}/abonnement/desinscrire?j=${a.jeton}`].join("\n");
    return env.ETAT.prepare(`INSERT INTO envois (genre, email, jeton, sujet, texte, html, apres) VALUES ('etat', ?, ?, ?, ?, ?, ?)`)
      .bind(a.email, a.jeton, m.sujet, texte, html, apres);
  });
  await env.ETAT.batch(stmts);
}

// La file : au plus `max` courriels par passage, reessai espace, abandon signale.
export async function traiterEnvois(env, t, max = ENVOIS_PAR_MINUTE) {
  if (!env.SCW_TEM_CLE || !env.SCW_PROJET || !env.ABONNEMENT_EXPEDITEUR) return;
  const { results } = await env.ETAT.prepare(`SELECT * FROM envois WHERE statut = 'a_envoyer' AND apres <= ?
    ORDER BY genre = 'confirmation' DESC, id LIMIT ?`).bind(t.toISOString(), max).all();
  let etatParti = false;
  for (const e of results || []) {
    try {
      await envoyerTem(env, e);
      await env.ETAT.prepare("DELETE FROM envois WHERE id = ?").bind(e.id).run();
      if (e.genre === "etat") etatParti = true;
    } catch (err) {
      const essais = (e.essais || 0) + 1;
      const abandon = essais >= ESSAIS_MAX;
      await env.ETAT.prepare("UPDATE envois SET essais = ?, erreur = ?, statut = ?, apres = ? WHERE id = ?")
        .bind(essais, String(err.message).slice(0, 300), abandon ? "abandon" : "a_envoyer",
              new Date(t.getTime() + essais * 5 * 60000).toISOString(), e.id).run();
      console.error(`envoi ${e.id} (${e.genre}) : ${err.message}`);
      if (abandon) await pushover(env, "Cursus Connect - abonnement",
        `Un courriel ${e.genre === "confirmation" ? "de confirmation" : "d'alerte"} aux abonnes n'a pas pu partir apres ${ESSAIS_MAX} essais : ${String(err.message).slice(0, 150)}`, 1);
    }
  }
  if (etatParti) await env.ETAT.prepare(`INSERT INTO compteurs (cle, n, valeur) VALUES ('derniere_notif', 0, ?)
    ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`).bind(t.toISOString()).run();
}

async function envoyerTem(env, e) {
  const entetes = [{ key: "Reply-To", value: REPONSE_SUPPORT }];
  if (e.genre === "etat") {
    const lien = `${baseVigie(env)}/abonnement/desinscrire?j=${e.jeton}`;
    entetes.push({ key: "List-Unsubscribe", value: `<${lien}>` }, { key: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" });
  }
  const r = await fetch("https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails", {
    method: "POST",
    headers: { "X-Auth-Token": env.SCW_TEM_CLE, "Content-Type": "application/json" },
    body: JSON.stringify({ from: { email: env.ABONNEMENT_EXPEDITEUR, name: "Cursus Connect — état des services" },
      to: [{ email: e.email }], subject: e.sujet, text: e.texte, html: e.html, project_id: env.SCW_PROJET,
      additional_headers: entetes }),
  });
  if (!r.ok) throw new Error(`Scaleway TEM : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

