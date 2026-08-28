#!/usr/bin/env node
/* Cursus Connect — relevé d'état, écrit l'historique de la page publique.

   Ce script est le cœur du dispositif, et il tient en trois gestes : il
   interroge /api/sante de la production, il range le verdict dans
   public/historique.json, il sort en erreur si la production est en panne —
   c'est cette sortie en erreur qui déclenche l'e-mail d'alerte de GitHub.

   Pourquoi un fichier versionné plutôt qu'une base : l'historique d'une page
   d'état est minuscule (trois compteurs par jour et par composant) mais il doit
   survivre à tout, y compris à nous. Dans le dépôt, il est sauvegardé par git,
   lisible sans outil, et il n'expire jamais — au contraire des exécutions
   GitHub, effacées au bout de 90 jours.

   Pourquoi trois essais : un hoquet réseau n'est pas une panne. Publier un
   incident inexistant use la confiance dans la page, et une page d'état à
   laquelle on ne croit plus ne sert plus à rien.

   Usage : node scripts/relever.mjs
   Variables : URL_SANTE, FICHIER (public/historique.json), FENETRE_JOURS (90),
               FUSEAU (Europe/Paris), ESSAIS (3), ATTENTE_MS (15000). */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const URL_SANTE = process.env.URL_SANTE || "https://cursusconnect.com/api/sante";
const FICHIER = process.env.FICHIER || "public/historique.json";
const FENETRE = Number(process.env.FENETRE_JOURS || 90);
const FUSEAU = process.env.FUSEAU || "Europe/Paris";
const ESSAIS = Number(process.env.ESSAIS || 3);
const ATTENTE_MS = Number(process.env.ATTENTE_MS || 15000);

const COMPOSANTS = ["application", "base", "stockage"];
const jourDe = (d) => new Intl.DateTimeFormat("fr-CA",
  { timeZone: FUSEAU, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); // AAAA-MM-JJ

const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- 1. interroger ------------------------------------------------------- */

async function lire() {
  const minuteur = AbortSignal.timeout(20000);
  const r = await fetch(`${URL_SANTE}?sonde=etat&t=${Date.now()}`,
    { signal: minuteur, headers: { "user-agent": "cursus-connect-etat" }, cache: "no-store" });
  /* 503 porte le MÊME corps que 200 : c'est justement là qu'il est utile. */
  const corps = await r.json();
  return { http: r.status, corps };
}

async function sonder() {
  let dernier = null;
  for (let essai = 1; essai <= ESSAIS; essai++) {
    try {
      const { http, corps } = await lire();
      const enRetard = corps.schema != null && corps.schemaRequis != null && corps.schema < corps.schemaRequis;
      const etat = {
        t: new Date().toISOString(),
        http,
        version: corps.version || null,
        application: corps.etat === "ok",
        base: corps.base === "ok",
        stockage: corps.stockage === "ok" || corps.stockage === "non configure",
        schemaEnRetard: enRetard,
        joignable: true,
      };
      dernier = etat;
      if (etat.application) {
        console.log(`✓ essai ${essai} : production en service (${etat.version})`);
        return etat;
      }
      console.log(`essai ${essai} : répond ${http} mais etat non-ok `
        + `(base=${corps.base} stockage=${corps.stockage} schema=${corps.schema}/${corps.schemaRequis})`);
    } catch (e) {
      console.log(`essai ${essai} : injoignable — ${e && e.message ? e.message : e}`);
      dernier = { t: new Date().toISOString(), http: 0, version: null,
        application: false, base: false, stockage: false, schemaEnRetard: false, joignable: false };
    }
    if (essai < ESSAIS) await dors(ATTENTE_MS);
  }
  return dernier;
}

/* --- 2. ranger ----------------------------------------------------------- */

function vide() {
  return {
    maj: null, fenetreJours: FENETRE, fuseau: FUSEAU,
    service: "cursus-connect", environnement: "production",
    composants: Object.fromEntries(COMPOSANTS.map((c) => [c, { jours: {} }])),
    incidents: [], dernier: null,
  };
}

function charger() {
  try {
    const h = JSON.parse(readFileSync(FICHIER, "utf8"));
    if (!h.composants) return vide();
    for (const c of COMPOSANTS) if (!h.composants[c]) h.composants[c] = { jours: {} };
    h.incidents = Array.isArray(h.incidents) ? h.incidents : [];
    return h;
  } catch {
    return vide(); // premier passage, ou fichier abîmé : on repart proprement
  }
}

function elaguer(jours, limite) {
  for (const d of Object.keys(jours)) if (d < limite) delete jours[d];
}

/* Ce qui a cassé, en une phrase lisible par un client. Ordre d'importance :
   on nomme la cause la plus profonde, celle qui explique les autres. */
function cause(e) {
  if (!e.joignable) return "service injoignable";
  if (!e.base) return "base de données indisponible";
  if (e.schemaEnRetard) return "maintenance de la base en cours";
  if (!e.stockage) return "stockage des fichiers indisponible";
  return "service dégradé";
}

const releve = await sonder();
const h = charger();
const jour = jourDe(new Date(releve.t));
const limite = jourDe(new Date(Date.now() - (FENETRE - 1) * 86400000));

for (const c of COMPOSANTS) {
  const jours = h.composants[c].jours;
  const j = jours[jour] || { n: 0, ko: 0 };
  j.n += 1;
  if (!releve[c]) j.ko += 1;
  jours[jour] = j;
  elaguer(jours, limite);
}

/* Les incidents suivent l'APPLICATION : c'est ce que vit le client. Une base
   momentanément indisponible sans conséquence visible n'a pas à figurer comme
   incident — mais elle apparaît quand même dans la barre du composant. */
const ouvert = h.incidents.find((i) => !i.fin);
if (!releve.application) {
  if (ouvert) { ouvert.dernier = releve.t; ouvert.releves += 1; ouvert.cause = cause(releve); }
  else h.incidents.push({ debut: releve.t, dernier: releve.t, fin: null, releves: 1, cause: cause(releve) });
} else if (ouvert) {
  ouvert.fin = releve.t;
}
h.incidents = h.incidents.filter((i) => i.debut >= new Date(Date.now() - FENETRE * 86400000).toISOString());

h.maj = releve.t;
h.fenetreJours = FENETRE;
h.fuseau = FUSEAU;
h.dernier = releve;

mkdirSync(dirname(FICHIER), { recursive: true });
writeFileSync(FICHIER, JSON.stringify(h, null, 2) + "\n");

const jJour = h.composants.application.jours[jour];
console.log(`↳ ${FICHIER} : ${jour} → ${jJour.n - jJour.ko}/${jJour.n} relevés au vert, `
  + `${h.incidents.filter((i) => !i.fin).length} incident(s) ouvert(s).`);

/* --- 3. alerter ---------------------------------------------------------- */
if (!releve.application) {
  console.log(`::error::PRODUCTION EN PANNE — ${cause(releve)} (après ${ESSAIS} essai${ESSAIS > 1 ? "s" : ""})`);
  process.exit(1);
}
