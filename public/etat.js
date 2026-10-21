/* Cursus Connect — page d'état publique.

   Deux sources, et la distinction est dite à l'écran :
     1. l'état VIVANT, mesuré à l'instant depuis le navigateur du visiteur en
        interrogeant directement /api/sante de la production (d'où l'en-tête
        CORS posé côté serveur en 1.546.0) ;
     2. l'HISTORIQUE, relevé toutes les 15 minutes par une sonde indépendante et
        publié dans un dépôt public (scripts/relever.mjs).

   La séparation est volontaire : si l'historique n'est pas joignable, la page
   dit quand même si le service marche MAINTENANT — c'est ce qu'un client vient
   chercher. L'inverse est vrai aussi.

   [module 2, 21.10.2026] Trois langues (décision PO S-1) : textes et causes dans
   langues.js, langue d'après le navigateur, choix FR · DE · EN mémorisé sur l'appareil. */
import { LANGUES, LOCALES, TEXTES, remplir, langueChoisie, traduireCause } from "./langues.js";

// [20.10.2026] L'application est servie sur app.cursusconnect.com (lot N, 1.615.0) ; la racine
// accueillera le site vitrine.
const SANTE = "https://app.cursusconnect.com/api/sante";
const HISTORIQUE = "https://raw.githubusercontent.com/lifesupportdistribution/cursus-connect-etat/main/public/historique.json";
const RYTHME_MS = 60000;
const FENETRE = 90;
const JOURS_INCIDENTS = 14;
const CLE_LANGUE = "cc-etat-langue";

const $ = (id) => document.getElementById(id);

/* ---------- la langue ------------------------------------------------------ */
const lireChoix = () => { try { return localStorage.getItem(CLE_LANGUE); } catch { return null; } };
const ecrireChoix = (l) => { try { localStorage.setItem(CLE_LANGUE, l); } catch { /* navigation privée : sans mémoire */ } };
let langue = langueChoisie({ recherche: location.search, stockage: lireChoix(), navigateur: navigator.languages || [navigator.language] });
const T = (cle, v) => remplir((TEXTES[langue] && TEXTES[langue][cle]) ?? TEXTES.fr[cle] ?? cle, v);
const locale = () => LOCALES[langue] || "fr-FR";
const dateHeure = (d) => new Intl.DateTimeFormat(locale(), { dateStyle: "short", timeStyle: "short" }).format(d);
const heure = (d) => new Intl.DateTimeFormat(locale(), { timeStyle: "short" }).format(d);
const dateLongue = (d) => new Intl.DateTimeFormat(locale(), { dateStyle: "long" }).format(d);
const pourcent = (x) => new Intl.NumberFormat(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
const jourISO = (d) => new Intl.DateTimeFormat("fr-CA",
  { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

function appliquerLangue(l) {
  langue = l;
  document.documentElement.lang = l;
  document.title = T("titre");
  const meta = document.querySelector('meta[name="description"]'); if (meta) meta.setAttribute("content", T("description"));
  document.querySelectorAll("[data-t]").forEach((e) => { e.textContent = T(e.dataset.t); });
  // data-t-html : textes du dictionnaire du dépôt (mise en gras), jamais une donnée reçue
  document.querySelectorAll("[data-t-html]").forEach((e) => { e.innerHTML = T(e.dataset.tHtml); });
  document.querySelectorAll("[data-t-aria]").forEach((e) => { e.setAttribute("aria-label", T(e.dataset.tAria)); });
  document.querySelectorAll("[data-t-placeholder]").forEach((e) => { e.setAttribute("placeholder", T(e.dataset.tPlaceholder)); });
  document.querySelectorAll("#langues [data-langue]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.langue === l ? "true" : "false"));
  const msg = $("abonnement-message"); if (msg) msg.hidden = true;
  peindreBanniere(); peindreComposants(); peindreIncidents(); peindreMeta();
}

const COMPOSANTS = ["application", "base", "stockage", "courriel"]; // [1.575.0] courriel

let vivant = null;      // dernier sondage navigateur
let histo = null;       // dernier historique chargé
let controle = null;    // heure du dernier sondage

/* ---------- l'état vivant -------------------------------------------------- */

async function sonder() {
  try {
    const r = await fetch(`${SANTE}?page=etat&t=${Date.now()}`, { cache: "no-store" });
    const corps = await r.json();   // 503 porte le MÊME corps : on le lit aussi
    vivant = {
      joignable: true,
      /* [1.575.0] Trois états : « degrade » = l'application sert, un composant
         est en défaut. Un bulletin plus ancien ne mesure pas l'envoi des e-mails. */
      application: corps.etat === "ok" || corps.etat === "degrade",
      degrade: corps.etat === "degrade",
      base: corps.base === "ok",
      stockage: corps.stockage === "ok" || (corps.stockage === "non configure" && corps.etat === "ok"),
      courriel: corps.courriel === undefined ? true : corps.courriel === "ok",
      version: corps.version || null,
    };
  } catch {
    /* Injoignable. Ce n'est pas forcément la faute du service : la connexion du
       visiteur peut être coupée. On le dit, plutôt que d'accuser à tort. */
    vivant = { joignable: false, application: false, degrade: false, base: false, stockage: false, courriel: false, version: null };
  }
  controle = new Date();
  peindreMeta();
  peindreBanniere();
  peindreComposants();
}

function peindreMeta() {
  $("m-controle").textContent = controle ? dateHeure(controle) : "—";
  $("m-version").textContent = (vivant && vivant.version) || "—";
  $("m-releve").textContent = histo && histo.maj ? dateHeure(new Date(histo.maj)) : "—";
}

function peindreBanniere() {
  const b = $("banniere");
  let classe = "attente", titre = T("etat.attente"), detail = T("etat.attenteDetail");
  if (!vivant) { /* rien encore */ }
  else if (!vivant.joignable) {
    classe = "panne"; titre = T("etat.injoignable"); detail = T("etat.injoignableDetail");
  } else if (vivant.application && !vivant.degrade) {
    classe = "ok"; titre = T("etat.ok"); detail = T("etat.okDetail");
  } else if (vivant.application) {
    /* [1.575.0] L'application sert : on nomme ce qui ne marche pas, sans rien
       dire de ce qui ne regarde pas le visiteur (protections internes). */
    const enDefaut = COMPOSANTS.filter((c) => c !== "application" && !vivant[c]).map((c) => T("defaut." + c));
    const quoi = !enDefaut.length ? T("etat.degradeInconnu")
      : enDefaut.length === 1 ? T("etat.degradeUn", { nom: enDefaut[0] })
      : T("etat.degradePlusieurs", { noms: enDefaut.join(T("etat.et")) });
    classe = "degrade"; titre = T("etat.degrade");
    detail = T("etat.degradeDetail", { quoi });
  } else {
    classe = "panne"; titre = T("etat.panne"); detail = T("etat.panneDetail");
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
    const jours = (histo && histo.composants && histo.composants[c] && histo.composants[c].jours) || {};

    const bloc = document.createElement("div");
    bloc.className = "composant";

    const tete = document.createElement("div");
    tete.className = "composant-tete";
    const nom = document.createElement("span");
    nom.className = "composant-nom";
    nom.textContent = T("comp." + c);
    const etat = document.createElement("span");
    if (!vivant) { etat.textContent = "…"; etat.className = "composant-etat e--muet"; }
    else if (!vivant.joignable) { etat.textContent = T("comp.indetermine"); etat.className = "composant-etat e--panne"; }
    else if (vivant[c]) { etat.textContent = T("comp.operationnel"); etat.className = "composant-etat e--ok"; }
    else { etat.textContent = c === "application" ? T("comp.perturbe") : T("comp.indisponible");
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
        ? T("barre.releves", { date: dateLongue(d), ok: j.n - j.ko, n: j.n })
        : T("barre.aucun", { date: dateLongue(d) });
      barres.appendChild(barre);
      if (j && j.n) { n += j.n; ko += j.ko; mesures += 1; }
    }

    const echelle = document.createElement("div");
    echelle.className = "echelle";
    const g = document.createElement("span"); g.textContent = T("echelle.debut");
    const t1 = document.createElement("i");
    const taux = document.createElement("b");
    taux.textContent = n ? T("echelle.taux", { taux: pourcent(100 * (n - ko) / n) }) : T("echelle.aucune");
    taux.title = n ? T("echelle.detail", { n, jours: mesures }) : "";
    const t2 = document.createElement("i");
    const d = document.createElement("span"); d.textContent = T("echelle.fin");
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
      vide.textContent = jourMesure(cle) ? T("incidents.aucun") : T("incidents.sansReleve");
      bloc.appendChild(vide);
    } else {
      for (const x of duJour) {
        const p = document.createElement("p");
        p.className = "incident";
        const fort = document.createElement("b");
        fort.textContent = x.fin ? T("incidents.resolu") : T("incidents.enCours");
        const texte = document.createElement("span");
        texte.className = "quand";
        const cause = traduireCause(x.cause, langue);
        texte.textContent = x.fin
          ? T("incidents.plage", { cause, debut: heure(new Date(x.debut)), fin: heure(new Date(x.fin)), n: x.releves })
          : T("incidents.depuis", { cause, debut: heure(new Date(x.debut)) });
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
  peindreMeta();
  peindreComposants();
  peindreIncidents();
}

/* Abonnement aux alertes d'incident. La page n'envoie que l'adresse et la langue
   affichée (décision S-2 : les courriels suivront cette langue) ; la vigie (Worker
   Cloudflare, cloudflare/vigie.js) envoie le courriel de confirmation, puis un courriel
   à chaque incident de production et à son rétablissement. Double consentement : rien
   ne part vers une adresse qui n'a pas confirmé. */
const URL_ABONNEMENT = "https://cursus-connect-vigie.fabien-boch.workers.dev/abonnement";
const formAbonnement = document.getElementById("form-abonnement");
if (formAbonnement) {
  formAbonnement.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const champ = document.getElementById("abonnement-email");
    const bouton = document.getElementById("abonnement-envoyer");
    const msg = document.getElementById("abonnement-message");
    const dire = (texte, erreur) => {
      msg.textContent = texte; msg.hidden = false;
      msg.classList.toggle("abonnement-note--erreur", !!erreur);
    };
    const email = champ.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { dire(T("abo.invalide"), true); champ.focus(); return; }
    bouton.disabled = true;
    try {
      const r = await fetch(URL_ABONNEMENT, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, langue }) });
      if (r.status === 202) {
        dire(T("abo.envoye", { email }));
        champ.value = "";
      } else if (r.status === 400) dire(T("abo.invalide"), true);
      else dire(T("abo.echec"), true);
    } catch (e) {
      dire(T("abo.echec"), true);
    } finally {
      bouton.disabled = false;
    }
  });
}

/* Le choix de langue : trois boutons, mémorisés sur l'appareil. */
const nav = $("langues");
if (nav) {
  nav.hidden = false;
  nav.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-langue]");
    if (!b || !LANGUES.includes(b.dataset.langue)) return;
    ecrireChoix(b.dataset.langue);
    appliquerLangue(b.dataset.langue);
  });
}

appliquerLangue(langue);
sonder();
charger();
setInterval(sonder, RYTHME_MS);
setInterval(charger, 5 * RYTHME_MS);
