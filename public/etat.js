/* Cursus Connect — page d'état publique.

   Deux sources, et la distinction est dite à l'écran :
     1. l'état VIVANT, mesuré à l'instant depuis le navigateur du visiteur en
        interrogeant directement /api/sante de la production (d'où l'en-tête
        CORS posé côté serveur en 1.546.0) ;
     2. l'HISTORIQUE, relevé toutes les 15 minutes par une sonde indépendante et
        publié dans un dépôt public (scripts/relever.mjs).

   La séparation est volontaire : si l'historique n'est pas joignable, la page
   dit quand même si le service marche MAINTENANT — c'est ce qu'un client vient
   chercher. L'inverse est vrai aussi. */

const SANTE = "https://cursusconnect.com/api/sante";
const HISTORIQUE = "https://raw.githubusercontent.com/lifesupportdistribution/cursus-connect-etat/main/public/historique.json";
const RYTHME_MS = 60000;
const FENETRE = 90;
const JOURS_INCIDENTS = 14;

const $ = (id) => document.getElementById(id);
const dateHeure = (d) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(d);
const heure = (d) => new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }).format(d);
const dateLongue = (d) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(d);
const jourISO = (d) => new Intl.DateTimeFormat("fr-CA",
  { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const COMPOSANTS = [
  { cle: "application", nom: "Application" },
  { cle: "base", nom: "Base de données" },
  { cle: "stockage", nom: "Stockage des fichiers" },
];

let vivant = null;      // dernier sondage navigateur
let histo = null;       // dernier historique chargé

/* ---------- l'état vivant -------------------------------------------------- */

async function sonder() {
  try {
    const r = await fetch(`${SANTE}?page=etat&t=${Date.now()}`, { cache: "no-store" });
    const corps = await r.json();   // 503 porte le MÊME corps : on le lit aussi
    vivant = {
      joignable: true,
      application: corps.etat === "ok",
      base: corps.base === "ok",
      stockage: corps.stockage === "ok" || corps.stockage === "non configure",
      version: corps.version || null,
    };
  } catch {
    /* Injoignable. Ce n'est pas forcément la faute du service : la connexion du
       visiteur peut être coupée. On le dit, plutôt que d'accuser à tort. */
    vivant = { joignable: false, application: false, base: false, stockage: false, version: null };
  }
  $("m-controle").textContent = dateHeure(new Date());
  $("m-version").textContent = vivant.version || "—";
  peindreBanniere();
  peindreComposants();
}

function peindreBanniere() {
  const b = $("banniere");
  let classe = "attente", titre = "Vérification en cours…", detail = "";
  if (!vivant) { /* rien encore */ }
  else if (!vivant.joignable) {
    classe = "panne"; titre = "Service injoignable";
    detail = "Votre navigateur n'a pas pu joindre Cursus Connect. Si le reste de votre connexion "
           + "fonctionne, le service est probablement en panne : nous en sommes prévenus automatiquement.";
  } else if (vivant.application) {
    classe = "ok"; titre = "Tous les services fonctionnent";
    detail = "Aucun incident en cours sur la production.";
  } else if (vivant.base && vivant.stockage) {
    classe = "degrade"; titre = "Service dégradé";
    detail = "L'application répond, mais l'un de ses composants ne fonctionne pas normalement.";
  } else {
    classe = "panne"; titre = "Incident en cours";
    detail = "Le service ne fonctionne pas normalement. Nos équipes en sont prévenues automatiquement.";
  }
  b.className = "banniere banniere--" + classe;
  $("banniere-titre").textContent = titre;
  $("banniere-detail").textContent = detail;
}

/* ---------- les composants et leurs 90 jours ------------------------------- */

function etatDuJour(j) {
  if (!j || !j.n) return "muet";
  if (!j.ko) return "ok";
  return j.ko >= j.n ? "panne" : "partiel";
}

function peindreComposants() {
  const hote = $("composants");
  hote.replaceChildren();
  for (const c of COMPOSANTS) {
    const jours = (histo && histo.composants && histo.composants[c.cle] && histo.composants[c.cle].jours) || {};

    const bloc = document.createElement("div");
    bloc.className = "composant";

    const tete = document.createElement("div");
    tete.className = "composant-tete";
    const nom = document.createElement("span");
    nom.className = "composant-nom";
    nom.textContent = c.nom;
    const etat = document.createElement("span");
    if (!vivant) { etat.textContent = "…"; etat.className = "composant-etat e--muet"; }
    else if (!vivant.joignable) { etat.textContent = "indéterminé"; etat.className = "composant-etat e--panne"; }
    else if (vivant[c.cle]) { etat.textContent = "Opérationnel"; etat.className = "composant-etat e--ok"; }
    else { etat.textContent = c.cle === "application" ? "Perturbé" : "Indisponible";
           etat.className = "composant-etat e--panne"; }
    tete.append(nom, etat);

    const barres = document.createElement("div");
    barres.className = "barres";
    let n = 0, ko = 0, mesures = 0;
    for (let i = FENETRE - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const cle = jourISO(d);
      const j = jours[cle];
      const e = etatDuJour(j);
      const barre = document.createElement("span");
      barre.className = "b--" + e;
      barre.title = j && j.n
        ? `${dateLongue(d)} — ${j.n - j.ko}/${j.n} relevés au vert`
        : `${dateLongue(d)} — pas de relevé`;
      barres.appendChild(barre);
      if (j && j.n) { n += j.n; ko += j.ko; mesures += 1; }
    }

    const echelle = document.createElement("div");
    echelle.className = "echelle";
    const g = document.createElement("span"); g.textContent = "il y a 90 jours";
    const t1 = document.createElement("i");
    const taux = document.createElement("b");
    taux.textContent = n
      ? `${(100 * (n - ko) / n).toFixed(2).replace(".", ",")} % de disponibilité`
      : "pas encore de mesure";
    taux.title = n ? `${n} relevés sur ${mesures} jour(s) mesuré(s)` : "";
    const t2 = document.createElement("i");
    const d = document.createElement("span"); d.textContent = "aujourd'hui";
    echelle.append(g, t1, taux, t2, d);

    bloc.append(tete, barres, echelle);
    hote.appendChild(bloc);
  }
}

/* ---------- les incidents passés, jour par jour ---------------------------- */

function peindreIncidents() {
  const hote = $("incidents");
  hote.replaceChildren();
  const incidents = (histo && histo.incidents) || [];

  for (let i = 0; i < JOURS_INCIDENTS; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const cle = jourISO(d);
    const duJour = incidents.filter((x) => jourISO(new Date(x.debut)) === cle);

    const bloc = document.createElement("div");
    bloc.className = "jour";
    const titre = document.createElement("p");
    titre.className = "jour-date";
    titre.textContent = dateLongue(d);
    bloc.appendChild(titre);

    if (!duJour.length) {
      const vide = document.createElement("p");
      vide.className = "jour-vide";
      /* On ne prétend pas « aucun incident » un jour où l'on n'a rien mesuré :
         l'absence de mesure n'est pas une preuve de bon fonctionnement. */
      vide.textContent = jourMesure(cle) ? "Aucun incident signalé." : "Pas de relevé ce jour-là.";
      bloc.appendChild(vide);
    } else {
      for (const x of duJour) {
        const p = document.createElement("p");
        p.className = "incident";
        const fort = document.createElement("b");
        fort.textContent = x.fin ? "Incident résolu" : "Incident en cours";
        const texte = document.createElement("span");
        texte.className = "quand";
        texte.textContent = x.fin
          ? ` — ${x.cause}, de ${heure(new Date(x.debut))} à ${heure(new Date(x.fin))} `
            + `(${x.releves} relevé${x.releves > 1 ? "s" : ""} en échec).`
          : ` — ${x.cause}, depuis ${heure(new Date(x.debut))}.`;
        p.append(fort, texte);
        bloc.appendChild(p);
      }
    }
    hote.appendChild(bloc);
  }
}

function jourMesure(cle) {
  const jours = histo && histo.composants && histo.composants.application && histo.composants.application.jours;
  return !!(jours && jours[cle] && jours[cle].n);
}

/* ---------- chargement ----------------------------------------------------- */

async function charger() {
  /* On lit d'abord l'historique VIVANT (le dépôt public, mis à jour toutes les
     15 minutes), et à défaut la copie déposée avec cette page. Cette copie date
     du dernier déploiement — donc elle est en retard — mais elle vaut mieux que
     des barres vides le jour où GitHub est injoignable. */
  for (const source of [HISTORIQUE, "historique.json"]) {
    try {
      const r = await fetch(source, { cache: "no-store" });
      if (r.ok) { histo = await r.json(); break; }
    } catch {
      /* Sans historique, la page garde son sens : l'état vivant reste affiché.
         On n'affiche pas d'erreur pour des barres absentes. */
    }
  }
  $("m-releve").textContent = histo && histo.maj ? dateHeure(new Date(histo.maj)) : "—";
  peindreComposants();
  peindreIncidents();
}

peindreComposants();
peindreIncidents();
sonder();
charger();
setInterval(sonder, RYTHME_MS);
setInterval(charger, 5 * RYTHME_MS);
