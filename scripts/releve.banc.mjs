// Banc du RELEVÉ (module 2, 21.10.2026) : deux relevés concurrents ne perdent rien.
// Rejoue, sans réseau ni GitHub, ce que fait .github/workflows/releve.yml : un dépôt d'origine
// local, deux clones partis du même commit, une fausse /api/sante, et l'étape « Publier le
// relevé » LUE DANS LE WORKFLOW (pas recopiée) et jouée par bash.
//   node scripts/releve.banc.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIOS_ATTENDUS = 9;
const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ICI, "..");
let n = 0; const ok = (m) => { n++; console.log("ok  " + m); };

// --- l'étape de publication, telle que le workflow l'écrit ---
const yml = readFileSync(join(RACINE, ".github/workflows/releve.yml"), "utf8");
const debut = yml.indexOf("      - name: Publier le relevé");
const bloc = yml.slice(debut, yml.indexOf("\n      - name:", debut + 10));
const PUBLIER = bloc.slice(bloc.indexOf("run: |") + 6).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
assert.ok(PUBLIER.includes("REJOUER=1 node scripts/relever.mjs"), "étape de publication introuvable dans releve.yml");
assert.match(yml, /ref: \$\{\{ github\.ref_name \}\}/);
ok("releve.yml : la tête de branche au démarrage, et l'étape de publication rejoue le relevé");

// --- fausse santé ---
let etat = "ok";
const srv = createServer((q, r) => { r.writeHead(etat === "ok" ? 200 : 503, { "content-type": "application/json" });
  r.end(JSON.stringify({ version: "1.616.0", etat: etat === "ok" ? "ok" : "hors service", base: etat === "ok" ? "ok" : "indisponible", stockage: "ok", courriel: "ok", schema: 20, schemaRequis: 20 })); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const URL_SANTE = `http://127.0.0.1:${srv.address().port}/api/sante`;

// --- dépôt d'origine et deux clones ---
const T = mkdtempSync(join(tmpdir(), "releve-banc-"));
const git = (dir, ...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git(T, "init", "-q", "--bare", "-b", "main", "origine.git");
const graine = join(T, "graine"); mkdirSync(graine);
git(graine, "init", "-q", "-b", "main"); git(graine, "config", "user.email", "b@b"); git(graine, "config", "user.name", "banc");
mkdirSync(join(graine, "public")); mkdirSync(join(graine, "scripts"));
cpSync(join(RACINE, "scripts/relever.mjs"), join(graine, "scripts/relever.mjs"));
writeFileSync(join(graine, "public/historique.json"), "{}\n");
git(graine, "add", "."); git(graine, "commit", "-q", "-m", "graine");
git(graine, "remote", "add", "origin", join(T, "origine.git")); git(graine, "push", "-q", "origin", "main");
const cloner = (nom) => { git(T, "clone", "-q", join(T, "origine.git"), nom); const d = join(T, nom); git(d, "config", "user.email", "b@b"); git(d, "config", "user.name", "sonde"); return d; };
const A = cloner("a"), B = cloner("b");

/* asynchrones : la fausse santé tourne dans CE processus, un appel bloquant l'empêcherait de répondre */
const lancer = (cmd, args, o) => new Promise((ok) => { const c = spawn(cmd, args, o); let stdout = "", stderr = "";
  c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; }); c.on("close", (status) => ok({ status, stdout, stderr })); });
const relever = (dir, extra = {}) => lancer("node", ["scripts/relever.mjs"], { cwd: dir,
  env: { ...process.env, URL_SANTE, ESSAIS: "1", ATTENTE_MS: "0", GITHUB_OUTPUT: "", RELEVE_FICHIER: join(dir, "..", `releve-${dir.slice(-1)}.json`), ...extra } });
const publier = (dir) => lancer("bash", ["-e", "-c", PUBLIER], { cwd: dir,
  env: { ...process.env, URL_SANTE, GITHUB_REF_NAME: "main", RELEVE_FICHIER: join(dir, "..", `releve-${dir.slice(-1)}.json`) } });
const histoOrigine = () => { const d = join(T, "lecture"); spawnSync("rm", ["-rf", d]); git(T, "clone", "-q", join(T, "origine.git"), "lecture"); return JSON.parse(readFileSync(join(d, "public/historique.json"), "utf8")); };
const totalJour = (h) => Object.values(h.composants.application.jours).reduce((a, j) => a + j.n, 0);

// 1. B mesure PUIS A mesure et publie le premier : B est devancé
{ const rb = await relever(B); assert.equal(rb.status, 0, rb.stdout + rb.stderr); }
await new Promise((r) => setTimeout(r, 20));
assert.equal((await relever(A)).status, 0);
let p = await publier(A); assert.equal(p.status, 0, p.stderr + p.stdout); assert.match(p.stdout, /relevé publié \(essai 1\)/);
ok("A publie au premier essai");
p = await publier(B); assert.equal(p.status, 0, p.stderr + p.stdout);
assert.match(p.stdout, /poussée devancée \(essai 1\)/); assert.match(p.stdout, /relevé publié \(essai 2\)/);
ok("B, devancé, rejoue son relevé sur la tête de branche et publie au deuxième essai");
let h = histoOrigine();
assert.equal(totalJour(h), 2);
ok("l'historique publié compte LES DEUX relevés (aucun perdu)");
const tA = JSON.parse(readFileSync(join(T, "releve-a.json"), "utf8")).t, tB = JSON.parse(readFileSync(join(T, "releve-b.json"), "utf8")).t;
assert.ok(tB < tA); assert.equal(h.maj, tA); assert.equal(h.dernier.t, tA);
ok("le relevé rejoué, plus ancien, ne recule pas la date du dernier relevé");

// 2. un relevé ancien en panne, rejoué derrière un relevé récent au vert : pas d'incident rouvert
git(A, "pull", "-q"); git(B, "fetch", "-q"); git(B, "reset", "-q", "--hard", "origin/main");
etat = "ko"; assert.equal((await relever(B)).status, 1); // la panne fait échouer l'étape (continue-on-error dans le workflow)
etat = "ok"; await new Promise((r) => setTimeout(r, 20)); assert.equal((await relever(A)).status, 0);
assert.equal((await publier(A)).status, 0); p = await publier(B); assert.equal(p.status, 0, p.stderr + p.stdout);
h = histoOrigine();
assert.equal(totalJour(h), 4); assert.equal(h.composants.application.jours[Object.keys(h.composants.application.jours)[0]].ko, 1);
ok("la panne ancienne compte dans la barre du jour (1 relevé au rouge sur 4)");
assert.equal(h.incidents.filter((i) => !i.fin).length, 0);
ok("… mais n'ouvre pas d'incident : le relevé le plus récent a dit « au vert »");

// 3. rejouer deux fois le même relevé n'ajoute rien
git(B, "fetch", "-q"); git(B, "reset", "-q", "--hard", "origin/main");
const r = await relever(B, { REJOUER: "1", RELEVE_FICHIER: join(T, "releve-a.json") });
assert.equal(r.status, 0); assert.match(r.stdout, /déjà présent/);
ok("un relevé déjà dans l'historique n'est pas compté deux fois");

// 4. REJOUER sans relevé lisible : refus clair
const r2 = await relever(B, { REJOUER: "1", RELEVE_FICHIER: join(T, "absent.json") });
assert.equal(r2.status, 2); assert.match(r2.stdout, /REJOUER sans RELEVE_FICHIER/);
ok("rejouer sans relevé : arrêt en erreur, rien d'écrit");

srv.close();
console.log(`\nbanc du relevé : ${n} scenarios passes (${SCENARIOS_ATTENDUS} attendus)`);
assert.equal(n, SCENARIOS_ATTENDUS);
