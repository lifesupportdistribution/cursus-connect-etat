# Cursus Connect — page d'état publique

Ce dépôt contient **la page d'état de [Cursus Connect](https://cursusconnect.com)**
et la sonde qui l'alimente. Rien d'autre.

- **Page publiée :** https://status.cursusconnect.com
- **Éditeur :** Life Support Distribution

## Pourquoi ce dépôt est séparé, et public

**Séparé**, parce qu'une page d'état hébergée avec ce qu'elle surveille tombe en
même temps que lui — précisément au moment où l'on vient la consulter. La page,
sa sonde et son historique vivent donc ailleurs que l'application, et chez
d'autres fournisseurs.

**Public**, parce que les minutes GitHub Actions sont facturées sur un dépôt
privé et gratuites sur un dépôt public. Une sonde au quart d'heure représente
~2 900 minutes par mois : impossible autrement.

Ce dépôt ne peut être public que parce qu'il **ne contient ni code applicatif ni
secret** : la sonde interroge une adresse publique, `/api/sante`, qui ne divulgue
ni nom d'hôte, ni identifiant, ni donnée personnelle — seulement « ça répond » ou
« ça ne répond pas », et le numéro de version.

## Ce qui tourne ici

| Quoi | Où | Quand |
|---|---|---|
| Relevé de l'état de la production | `scripts/relever.mjs` | toutes les 15 min (`.github/workflows/releve.yml`) |
| Historique consigné | `public/historique.json` | écrit et poussé à chaque relevé |
| Alerte en cas de panne | échec du workflow → e-mail GitHub | à la panne |
| Page publique | `public/` | déployée par Cloudflare Pages |

L'historique est **versionné** : il ne s'efface pas au bout de 90 jours comme les
exécutions GitHub, et git en garde toutes les révisions.

## Ce que la page affiche

- **L'état vivant**, mesuré depuis le navigateur du visiteur, qui interroge
  directement la production. Ce n'est pas un cache : c'est un contrôle fait à
  l'instant où l'on regarde.
- **90 jours de disponibilité par composant**, dérivés des relevés.
- **Les incidents passés**, jour par jour.

Une journée sans relevé est affichée en gris et **ne compte pas** dans le taux de
disponibilité : une absence de mesure n'est pas une preuve de bon fonctionnement.

## Aucune donnée collectée

Pas de cookie, pas de mesure d'audience, aucun appel à un service tiers. La
politique de sécurité de contenu servie avec la page (`public/_headers`)
n'autorise que deux origines distantes : le service surveillé et cet historique.
