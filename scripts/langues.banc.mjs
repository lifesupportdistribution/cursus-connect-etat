// Banc des LANGUES de la page d'état (module 2, 21.10.2026, décision PO S-1).
// Vérifie, sans navigateur, que les trois langues disent la même chose au même endroit :
//   node scripts/langues.banc.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUES, LOCALES, TEXTES, CAUSES, remplir, langueChoisie, traduireCause } from "../public/langues.js";

const SCENARIOS_ATTENDUS = 9;
const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const lire = (f) => readFileSync(join(RACINE, f), "utf8");
let n = 0; const ok = (m) => { n++; console.log("ok  " + m); };
const html = lire("public/index.html"), script = lire("public/etat.js"), releveur = lire("scripts/relever.mjs");
const espaces = (s) => String(s).replace(/\s+/g, " ").trim();

// 1. mêmes clés, aucune vide, dans les trois langues
assert.deepEqual(LANGUES, ["fr", "de", "en"]); assert.deepEqual(Object.keys(LOCALES), LANGUES);
const cles = Object.keys(TEXTES.fr).sort();
for (const l of LANGUES) {
  assert.deepEqual(Object.keys(TEXTES[l]).sort(), cles, `clés différentes en ${l}`);
  for (const k of cles) assert.ok(typeof TEXTES[l][k] === "string" && TEXTES[l][k].trim(), `${l}.${k} vide`);
}
ok(`${cles.length} textes, les mêmes clés en français, allemand et anglais, aucun vide`);

// 2. mêmes emplacements {x} et même mise en gras
const trous = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const gras = (s) => (s.match(/<b>/g) || []).length;
for (const l of ["de", "en"]) for (const k of cles) {
  assert.deepEqual(trous(TEXTES[l][k]), trous(TEXTES.fr[k]), `${l}.${k} : emplacements différents`);
  assert.equal(gras(TEXTES[l][k]), gras(TEXTES.fr[k]), `${l}.${k} : mise en gras différente`);
  assert.equal((TEXTES[l][k].match(/<\/?(?!b>|\/b>)[a-z]/gi) || []).length, 0, `${l}.${k} : balise autre que <b>`);
}
ok("chaque texte garde ses emplacements ({email}, {nom}…) et sa mise en gras ; aucune autre balise");

// 3. chaque clé appelée par la page existe
const attributs = [...html.matchAll(/data-t(?:-html|-aria|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
const appels = [...script.matchAll(/T\("([a-zA-Z.]+)"[,)]/g)].map((m) => m[1]);
const composants = JSON.parse(/const COMPOSANTS = (\[[^\]]+\])/.exec(script)[1]);
const dynamiques = [...composants.map((c) => "comp." + c), ...composants.filter((c) => c !== "application").map((c) => "defaut." + c)];
const manquantes = [...attributs, ...appels, ...dynamiques].filter((k) => !(k in TEXTES.fr));
assert.deepEqual(manquantes, []);
const employees = new Set([...attributs, ...appels, ...dynamiques]);
assert.deepEqual(cles.filter((k) => !employees.has(k)), [], "texte que la page n'emploie plus"); assert.ok(attributs.length >= 20 && appels.length >= 30, "relevé des clés trop maigre : l'expression a-t-elle cessé de les trouver ?");
ok(`${employees.size} clés appelées par index.html et etat.js, toutes présentes ; aucun texte orphelin`);

// 4. sans JavaScript, la page dit le texte français du dictionnaire, mot pour mot
let compares = 0;
for (const m of html.matchAll(/<([a-z0-9]+)[^>]*\sdata-t(-html)?="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
  compares++;
  const [, , avecGras, cle, contenu] = m;
  assert.equal(espaces(contenu), espaces(TEXTES.fr[cle]), `index.html « ${cle} » diffère du dictionnaire`);
  if (!avecGras) assert.ok(!/<b>/.test(contenu), `${cle} : gras sans data-t-html`);
}
assert.ok(compares >= 20, `${compares} textes comparés seulement`);
assert.equal(espaces(/<title>([^<]+)<\/title>/.exec(html)[1]), TEXTES.fr.titre);
assert.equal(/<meta name="description" content="([^"]+)"/.exec(html)[1], TEXTES.fr.description);
assert.equal(/placeholder="([^"]+)"/.exec(html)[1], TEXTES.fr["abo.exemple"]);
ok("le français écrit dans index.html (navigateur sans JavaScript) est celui du dictionnaire");

// 5. chaque cause que le relevé peut écrire a sa traduction
const causes = [...(/function cause\(e\) \{([\s\S]*?)\n\}/.exec(releveur)[1]).matchAll(/return "([^"]+)"/g)].map((m) => m[1]);
assert.ok(causes.length >= 6);
assert.deepEqual(causes.filter((c) => !(CAUSES[c] && CAUSES[c].de && CAUSES[c].en)), []);
assert.deepEqual(Object.keys(CAUSES).filter((c) => !causes.includes(c)), [], "traduction d'une cause que le relevé n'écrit plus");
ok(`les ${causes.length} causes écrites par scripts/relever.mjs sont traduites, et seulement elles`);

// 6. traduction des causes
assert.equal(traduireCause("base de données indisponible", "de"), "Datenbank nicht verfügbar");
assert.equal(traduireCause("base de données indisponible", "fr"), "base de données indisponible");
assert.equal(traduireCause("cause d'une version future", "en"), "cause d'une version future");
ok("une cause connue est traduite ; une cause inconnue s'affiche telle quelle plutôt que de disparaître");

// 7. le choix de la langue
const c = (o) => langueChoisie(o);
assert.equal(c({ recherche: "?lang=de", stockage: "en", navigateur: ["fr-FR"] }), "de");
assert.equal(c({ recherche: "?lang=it", stockage: "en", navigateur: ["de-CH"] }), "en");
assert.equal(c({ recherche: "", stockage: "zz", navigateur: ["it-IT", "de-CH", "en"] }), "de");
assert.equal(c({ recherche: "", stockage: null, navigateur: ["EN-us"] }), "en");
assert.equal(c({ recherche: "", stockage: null, navigateur: ["it", "es"] }), "fr");
assert.equal(c({ recherche: "%%%", stockage: null, navigateur: [undefined] }), "fr");
assert.equal(c(), "fr");
ok("langue : ?lang= d'abord, puis le choix mémorisé, puis le navigateur (de-CH → allemand), sinon le français");

// 8. remplissage
assert.equal(remplir(TEXTES.en["abo.envoye"], { email: "a@b.ch" }).includes("a@b.ch"), true);
assert.equal(remplir("{x} et {y}", { x: 1 }), "1 et {y}");
ok("remplissage : la valeur à sa place, un emplacement sans valeur reste visible");

// 9. le choix reste sur l'appareil : stockage local protégé, aucun envoi
assert.match(script, /try \{ return localStorage\.getItem\(CLE_LANGUE\); \} catch/);
assert.match(script, /try \{ localStorage\.setItem\(CLE_LANGUE, l\); \} catch/);
assert.doesNotMatch(lire("public/langues.js"), /fetch\(|localStorage/);
assert.match(TEXTES.fr["expl.p3"], /Votre choix de langue reste sur votre appareil/);
ok("le choix de langue est mémorisé dans le navigateur seulement (lecture et écriture protégées), et la page le dit");

console.log(`\nbanc des langues : ${n} scenarios passes (${SCENARIOS_ATTENDUS} attendus)`);
assert.equal(n, SCENARIOS_ATTENDUS);
