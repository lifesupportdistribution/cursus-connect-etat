# La vigie — `cloudflare/vigie.js`

Worker Cloudflare qui surveille Cursus Connect à la minute, reçoit les signaux
du produit, alerte le téléphone de l'exploitant, et **prévient par courriel les
abonnés de la page d'état** à chaque incident de production et à son
rétablissement. Ce dossier ne contient
**aucun secret ni aucune adresse** : tout vient des variables du Worker. Le code
peut donc vivre dans ce dépôt public.

## Ce qu'elle fait

**Chaque minute**

1. Sonde `/api/sante` de la production (délai 10 s) et, aux minutes multiples
   de 5, celui du test. Chaque relevé alimente les mesures horaires (nombre,
   défauts, durée moyenne et pire), gardées 7 jours.
2. Ne change d'état qu'après **deux relevés identiques d'affilée** : un hoquet
   n'est pas une panne. Chaque transition est journalisée.
3. À chaque transition, **une** notification Pushover ; rappel toutes les heures
   tant que la production reste en panne.
4. Aux minutes 07, 22, 37 et 52, demande à GitHub le relevé de `releve.yml`
   (`workflow_dispatch`) : c'est lui qui tient l'historique et la page publique.
5. À la minute 30 de chaque heure, vérifie que les **tâches planifiées** du
   produit ont donné signe de vie : `purges` depuis moins de 26 h, `sauvegardes`
   depuis moins de 20 h. Une tâche n'est surveillée qu'après son premier signe
   de vie.
6. À 05:50 UTC, joue l'**épreuve d'environnement** du produit (`POST /api/epreuve`,
   lot 1.577.0) sur la production puis sur le test. Le produit y **exerce** chaque
   réglage : il écrit, relit et efface un objet témoin dans le stockage, envoie un
   courriel témoin à `EPREUVE_DESTINATAIRE`, ouvre une connexion avec l'URL de
   maintenance, vérifie l'environnement déclaré, l'expéditeur et la console. Elle
   est **rejouée dès qu'une nouvelle version apparaît** sur un environnement.
   C'est la garantie « ce qui est testé en test fonctionne en production » : même
   code des deux côtés, réglages prouvés des deux côtés.
7. À 06:00 UTC : les **échéances** (préavis 30 jours, rappel hebdomadaire puis
   quotidien à 7 jours), une **preuve de vie** muette (qui rend compte de
   l'épreuve), et le ménage.

**Sur demande**

- `POST /signal` : le produit se signale lui-même (lot 1.576.0). Jeton Bearer
  partagé avec Vercel. Corps : `{ env, type: "tache"|"anomalie", nom, ok, detail }`.
  Une anomalie alerte à la première occurrence, puis une fois par heure au plus ;
  le retour est annoncé.
- `POST /abonnement` : inscription aux alertes d'incident, depuis la page
  d'état (CORS limité à `ABONNEMENT_ORIGINE`). Réponse identique que l'adresse
  soit connue ou non ; une relance au plus toutes les 10 min par adresse ;
  200 confirmations au plus par jour.
- `GET|POST /abonnement/confirmer?j=…` : le lien du courriel affiche un
  **bouton** ; seul le POST confirme. Un antivirus de messagerie qui suit les
  liens ne confirme donc rien à la place du destinataire.
- `GET|POST /abonnement/desinscrire?j=…` : même principe ; accepte aussi le
  POST « en un clic » des messageries (RFC 8058, en-têtes `List-Unsubscribe`).
  L'adresse est **effacée**.
- `GET /tableau` : le **tableau de bord** de l'exploitant, en authentification Basic
  (utilisateur `lsd`). Il vit ici et non dans le produit : le jour où le produit
  tombe, c'est là qu'on regarde.

| Événement | Pushover (production) |
|---|---|
| hors service, injoignable | **urgence** : sonne chaque minute jusqu'à accusé de réception, 1 h |
| dégradé, tâche en échec ou muette, anomalie, échéance à moins de 30 jours, **épreuve d'environnement en échec** | haute : sonne, même en heures calmes |
| retour à la normale | normale |

**Les abonnés** reçoivent, pour la production seulement : « incident en cours »
(hors service ou injoignable), « service dégradé » (en mots de client : « le
dépôt et la consultation des fichiers », « l'envoi des e-mails »), « service
rétabli ». Jamais un nom de composant interne ni un code d'erreur. Une rafale
est **fusionnée** : un courriel d'état au plus toutes les 10 minutes, portant
l'état le plus récent. Envoi par l'API de Scaleway Transactional Email, par une
**file en base** : 15 courriels par minute (plafonds du plan gratuit de
Workers), cinq essais espacés, abandon signalé à l'exploitant.
| preuve de vie | la plus basse : muette |

Le test : priorité normale pour tout, sans rappel.

## Réglages dans le tableau de bord Cloudflare

| Nom | Type | Rôle |
|---|---|---|
| `SONDE_PRODUCTION_URL` | texte | bulletin public de la production |
| `SONDE_TEST_URL` | texte | bulletin du test — absent = pas de sonde test |
| `GITHUB_JETON` | secret | jeton à granularité fine, **ce dépôt seul**, Actions en lecture/écriture |
| `PUSHOVER_JETON` | secret | jeton de l'application Pushover |
| `PUSHOVER_UTILISATEUR` | secret | clé d'utilisateur Pushover du destinataire |
| `VIGIE_SIGNAL_JETON` | secret | partagé avec Vercel (test et production) — absent = `/signal` fermé et épreuve non jouée |
| `EPREUVE_DESTINATAIRE` | texte | adresse LSD qui reçoit le courriel témoin de l'épreuve (deux par jour : test et production) |
| `VIGIE_TABLEAU_MDP` | secret | mot de passe du tableau de bord — absent = tableau fermé |
| `SCW_TEM_CLE` | secret | clé d'API Scaleway (envoi Transactional Email) — absent = abonnement fermé (503) |
| `SCW_PROJET` | texte | identifiant du projet Scaleway qui porte le domaine d'envoi |
| `ABONNEMENT_EXPEDITEUR` | texte | `ne-pas-repondre@notifications.cursusconnect.com` (domaine vérifié chez Scaleway ; relevé le 04.10.2026) |
| `ABONNEMENT_ORIGINE` | texte | `https://status.cursusconnect.com` |
| `VIGIE_URL` | texte | `https://cursus-connect-vigie.fabien-boch.workers.dev` (liens des courriels) |
| `ETAT` | liaison D1 | base SQLite ; ses tables se créent seules |
| `VERSION_CODE` | métadonnées de version | identifiant et étiquette de la version en service (tableau de bord, « Code en service ») — déclarée dans `wrangler.toml` |
| Cron Trigger | `* * * * *` | déclaré dans `wrangler.toml` |

Les liaisons, le déclencheur, la date de compatibilité et les journaux sont
**décrits dans `cloudflare/wrangler.toml`** et posés à chaque déploiement. Les
variables texte et les secrets ci-dessus restent **dans Cloudflare** :
`keep_vars = true` garde les variables, et un déploiement ne touche jamais aux
secrets. Ce dépôt reste donc sans secret ni adresse.

Secrets **du dépôt GitHub** (Settings → Secrets and variables → Actions), pour le
déploiement et le contrôle du matin :

| Nom | Rôle |
|---|---|
| `CLOUDFLARE_API_TOKEN` | jeton Cloudflare limité aux Workers de ce compte ; **échéance 04.10.2027**, au registre de la vigie (`ECHEANCES_FIXES`) |
| `CLOUDFLARE_ACCOUNT_ID` | identifiant du compte Cloudflare |

D1 et non KV : KV est à cohérence différée (jusqu'à 60 s). Une sonde à la
minute qui relit un état périmé juste après l'avoir écrit alerterait deux fois.

Les **échéances fixes** (clé Scaleway, jeton GitHub) sont dans le code,
`ECHEANCES_FIXES` : à mettre à jour à chaque rotation, dans le même commit que
l'entrée du journal des rotations. Le nom de domaine est lu en direct (RDAP).

## Données personnelles (abonnement)

Seule donnée : l'adresse e-mail, avec sa date d'inscription, sa date de
confirmation et un jeton aléatoire. Base D1 en **juridiction UE**. Une
inscription non confirmée est **effacée après 48 heures** ; une désinscription
**efface** l'adresse. Aucune image, aucun pixel de suivi dans les courriels.
Responsable : Life Support Distribution. À inscrire au registre des traitements.

## Déployer une nouvelle version

**Depuis le 04.10.2026 (lot 10 du registre d'audit, P2-03), uniquement depuis ce
dépôt.** Pousser dans `main` une modification de `cloudflare/vigie.js`,
`cloudflare/wrangler.toml` ou de leurs bancs déclenche `vigie-deployer.yml` :

1. le banc de la vigie et celui du contrôle de conformité (comptes exacts) ;
2. `wrangler deploy` (version épinglée), version **étiquetée** par l'empreinte de
   `vigie.js` et de `wrangler.toml` (identifiants de blob git, 10 caractères
   chacun) ; le message de la version porte le commit ;
3. la vérification, par l'API Cloudflare, que la version active porte cette
   étiquette.

Le même workflow se relance à la main (*Actions → vigie-deployer → Run workflow*).
**Plus de copier-coller dans l'éditeur** : une version qui n'en viendrait pas n'a
pas d'étiquette ; le tableau de bord l'affiche en rouge (« SANS étiquette :
déployée hors du dépôt ») et le contrôle du matin (`vigie-conformite.yml`,
demandé par la vigie à 06:05 UTC) échoue, ce qui envoie l'e-mail de GitHub.

## Cinq pièges du tableau de bord (constatés les 19 et 20.09.2026)

- **Modifier une variable crée une version sans la déployer**, même via le
  bouton « Déployer ». Contrôler *Déploiements* ; au besoin *Promouvoir la
  version*.
- **Modifier un déclencheur cron existant n'a pas d'effet**, même si l'écran
  affiche la nouvelle expression. Supprimer, enregistrer, recréer.
- **Supprimer un déclencheur agit avec une dizaine de minutes de retard.**
- **« Secret » est une case à cocher** à droite du champ Valeur, non cochée par
  défaut. Une valeur enregistrée sans elle est lisible en clair.
- **L'éditeur de code ouvre un aperçu de la racine du Worker.** Si la racine
  demande un mot de passe, la fenêtre de connexion bloque tout l'onglet. C'est
  pourquoi le tableau de bord est sous `/tableau` et la racine répond 404.

## Éprouver sans casser la production

- **Le banc** : `node cloudflare/vigie.banc.mjs` rejoue ses scénarios (compte exact
  vérifié par le banc lui-même) sans réseau
  ni Cloudflare. D1 y est simulée par le SQLite intégré à Node (Node 22.13 ou
  plus) : les requêtes du Worker sont exécutées pour de vrai. Heures simulées
  seulement : le banc passe quelle que soit l'heure réelle.
- **L'alerte** : pointer `SONDE_PRODUCTION_URL` sur une adresse qui répond 404
  (celle du Worker lui-même convient), **promouvoir la version**, attendre deux
  minutes : alerte urgence. Remettre l'adresse, promouvoir : « Retabli ».
  [lot 10] Ces versions faites dans le tableau de bord n'ont pas d'étiquette :
  relancer ensuite `vigie-deployer` pour revenir à la version du dépôt, sinon le
  contrôle du matin échoue — c'est son rôle.
- **Le chien de garde de `releve.yml`** : remplacer le Cron Trigger par
  `0-6,8-21,23-36,38-51,53-59 * * * *` pendant plus d'une heure, puis remettre
  `* * * * *` (supprimer et recréer). Le relevé suivant échoue avec
  « Declencheur muet ». [lot 10] Le prochain déploiement repose de toute façon le
  déclencheur de `wrangler.toml`.
- **Un signal** : `curl -X POST <adresse>/signal -H "Authorization: Bearer <jeton>"
  -H "Content-Type: application/json" -d '{"env":"test","type":"anomalie","nom":"essai","ok":false,"detail":"essai"}'`
  → notification de priorité normale ; le même avec `"ok":true` → « resolue ».

- **L'abonnement** : s'inscrire depuis la page d'état avec sa propre adresse,
  confirmer par le bouton du courriel, puis vérifier le compteur du tableau de
  bord. Se désinscrire par le lien d'un courriel d'état.

- **L'épreuve d'environnement** : `curl -X POST <adresse de l'environnement>/api/epreuve
  -H "Authorization: Bearer <jeton>" -H "Content-Type: application/json" -d '{}'`
  → un verdict par réglage (sans courriel témoin si `destinataire` est absent).
  Le tableau de bord montre la dernière épreuve de chaque environnement.

## Ce qu'elle ne fait pas

Elle ne voit que ce que le bulletin public déclare et ce que le produit lui
signale. Les parcours complets d'un utilisateur (connexion, dépôt de fichier,
portail) seront éprouvés par un compte sonde, après la création du centre de
démonstration en production.
