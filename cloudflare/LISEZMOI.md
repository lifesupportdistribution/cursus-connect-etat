# La vigie — `cloudflare/vigie.js`

Worker Cloudflare qui surveille Cursus Connect à la minute et alerte le
téléphone de l'exploitant. Ce dossier ne contient **aucun secret ni aucune
adresse** : tout vient des variables du Worker. Le code peut donc vivre dans ce
dépôt public.

## Ce qu'elle fait, chaque minute

1. Sonde `/api/sante` de la production (délai 10 s) et, aux minutes multiples
   de 5, celui du test.
2. Ne change d'état qu'après **deux relevés identiques d'affilée** : un hoquet
   n'est pas une panne.
3. À chaque transition, **une** notification Pushover ; rappel toutes les heures
   tant que la production reste en panne.
4. Aux minutes 07, 22, 37 et 52, demande à GitHub le relevé de `releve.yml`
   (`workflow_dispatch`) — c'est lui qui tient l'historique et la page d'état.
5. À 06:00 UTC, envoie une preuve de vie muette.

| Verdict | Quand | Pushover (production) |
|---|---|---|
| `ok` | HTTP 200 et `etat: "ok"` | rétablissement : priorité normale, avec la durée |
| `degrade` | `etat: "degrade"` (à venir) | haute : sonne, même en heures calmes |
| `hors_service` | HTTP 503 ou `etat: "hors service"` | **urgence** : sonne chaque minute jusqu'à accusé de réception, 1 h |
| `injoignable` | réseau, délai, réponse illisible ou inattendue | urgence |

Le test : priorité normale pour tout, sans rappel.

## Réglages dans le tableau de bord Cloudflare

| Nom | Type | Rôle |
|---|---|---|
| `SONDE_PRODUCTION_URL` | texte | bulletin public de la production |
| `SONDE_TEST_URL` | texte | bulletin du test — absent = pas de sonde test |
| `GITHUB_JETON` | secret | jeton à granularité fine, **ce dépôt seul**, Actions en lecture/écriture |
| `PUSHOVER_JETON` | secret | jeton de l'application Pushover |
| `PUSHOVER_UTILISATEUR` | secret | clé d'utilisateur Pushover du destinataire |
| `ETAT` | liaison D1 | base SQLite où vit le dernier verdict ; la table se crée seule |
| Cron Trigger | `* * * * *` | |

D1 et non KV : KV est à cohérence différée (jusqu'à 60 s). Une sonde à la
minute qui relit un état périmé juste après l'avoir écrit alerterait deux fois.

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

- **L'alerte** : pointer `SONDE_PRODUCTION_URL` sur une adresse qui répond 404
  (celle du Worker lui-même convient), **promouvoir la version**, attendre deux
  minutes : alerte urgence. Remettre l'adresse, promouvoir : « Retabli ». Lire
  la table `etat` dans la console D1 pour voir les transitions.
- **Le chien de garde de `releve.yml`** : remplacer le Cron Trigger par
  `0-6,8-21,23-36,38-51,53-59 * * * *` (tout sauf les minutes de
  déclenchement) pendant plus d'une heure, puis remettre `* * * * *` (supprimer
  et recréer). Le relevé suivant échoue avec « Declencheur muet ».
- **Le banc** : `node cloudflare/vigie.banc.mjs` rejoue 16 scénarios sans
  réseau ni Cloudflare (panne confirmée, rappel, rétablissement, hoquet isolé,
  dégradé, test, Pushover en échec, preuve de vie, refus GitHub).

## Ce qu'elle ne fait pas

Elle ne lit que le bulletin public : ce que le serveur ne déclare pas, elle ne
le voit pas. C'est l'objet des phases suivantes du chantier « santé et alertes ».
