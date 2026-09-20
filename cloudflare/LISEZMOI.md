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
6. À 06:00 UTC : les **échéances** (préavis 30 jours, rappel hebdomadaire puis
   quotidien à 7 jours), une **preuve de vie** muette, et le ménage.

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
- `GET /` : le **tableau de bord** de l'exploitant, en authentification Basic
  (utilisateur `lsd`). Il vit ici et non dans le produit : le jour où le produit
  tombe, c'est là qu'on regarde.

| Événement | Pushover (production) |
|---|---|
| hors service, injoignable | **urgence** : sonne chaque minute jusqu'à accusé de réception, 1 h |
| dégradé, tâche en échec ou muette, anomalie, échéance à moins de 30 jours | haute : sonne, même en heures calmes |
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
| `VIGIE_SIGNAL_JETON` | secret | partagé avec Vercel (test et production) — absent = `/signal` fermé |
| `VIGIE_TABLEAU_MDP` | secret | mot de passe du tableau de bord — absent = tableau fermé |
| `SCW_TEM_CLE` | secret | clé d'API Scaleway (envoi Transactional Email) — absent = abonnement fermé (503) |
| `SCW_PROJET` | texte | identifiant du projet Scaleway qui porte le domaine d'envoi |
| `ABONNEMENT_EXPEDITEUR` | texte | `etat@cursusconnect.com` (domaine vérifié chez Scaleway) |
| `ABONNEMENT_ORIGINE` | texte | `https://status.cursusconnect.com` |
| `VIGIE_URL` | texte | `https://cursus-connect-vigie.fabien-boch.workers.dev` (liens des courriels) |
| `ETAT` | liaison D1 | base SQLite ; ses tables se créent seules |
| Cron Trigger | `* * * * *` | |

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

1. *Modifier le code* → coller `vigie.js` en entier → **Déployer** (l'éditeur
   doit afficher 0 erreur).
2. Vérifier dans *Déploiements* que le « Déploiement actif » porte la nouvelle
   version.

## Quatre pièges du tableau de bord (constatés le 19.09.2026)

- **Modifier une variable crée une version sans la déployer**, même via le
  bouton « Déployer ». Contrôler *Déploiements* ; au besoin *Promouvoir la
  version*.
- **Modifier un déclencheur cron existant n'a pas d'effet**, même si l'écran
  affiche la nouvelle expression. Supprimer, enregistrer, recréer.
- **Supprimer un déclencheur agit avec une dizaine de minutes de retard.**
- **« Secret » est une case à cocher** à droite du champ Valeur, non cochée par
  défaut. Une valeur enregistrée sans elle est lisible en clair.

## Éprouver sans casser la production

- **Le banc** : `node cloudflare/vigie.banc.mjs` rejoue 32 scénarios sans réseau
  ni Cloudflare. D1 y est simulée par le SQLite intégré à Node (Node 22.13 ou
  plus) : les requêtes du Worker sont exécutées pour de vrai. Heures simulées
  seulement : le banc passe quelle que soit l'heure réelle.
- **L'alerte** : pointer `SONDE_PRODUCTION_URL` sur une adresse qui répond 404
  (celle du Worker lui-même convient), **promouvoir la version**, attendre deux
  minutes : alerte urgence. Remettre l'adresse, promouvoir : « Retabli ».
- **Le chien de garde de `releve.yml`** : remplacer le Cron Trigger par
  `0-6,8-21,23-36,38-51,53-59 * * * *` pendant plus d'une heure, puis remettre
  `* * * * *` (supprimer et recréer). Le relevé suivant échoue avec
  « Declencheur muet ».
- **Un signal** : `curl -X POST <adresse>/signal -H "Authorization: Bearer <jeton>"
  -H "Content-Type: application/json" -d '{"env":"test","type":"anomalie","nom":"essai","ok":false,"detail":"essai"}'`
  → notification de priorité normale ; le même avec `"ok":true` → « resolue ».

- **L'abonnement** : s'inscrire depuis la page d'état avec sa propre adresse,
  confirmer par le bouton du courriel, puis vérifier le compteur du tableau de
  bord. Se désinscrire par le lien d'un courriel d'état.

## Ce qu'elle ne fait pas

Elle ne voit que ce que le bulletin public déclare et ce que le produit lui
signale. Les parcours complets d'un utilisateur (connexion, dépôt de fichier,
portail) seront éprouvés par un compte sonde, après la création du centre de
démonstration en production.
