# Safetrip Voyageur Tracker — prototype

Application de suivi de trajets voyageurs **avec consentement explicite**,
sans capteur matériel à installer dans le véhicule : chaque voyageur
partage sa position depuis son propre téléphone, via son navigateur,
pendant la durée du trajet qu'il choisit de partager.

## Ce que fait réellement ce système — et ce qu'il ne fait pas

**Ce qui fonctionne :**
- Un voyageur ouvre `passenger.html` sur son téléphone, lit les conditions
  d'utilisation, coche la case de consentement et démarre le partage.
- Avant de démarrer, il renseigne une fiche de trajet : moyen de
  transport, agence (pour le transport en commun), point de départ et
  d'arrivée, coût payé, et des détails facultatifs (immatriculation du
  véhicule, n° de siège, heure de départ prévue, notes). Le moyen de
  transport, le départ et l'arrivée sont obligatoires — le serveur refuse
  la création du trajet sans eux (`error: "missing_required_fields"`).
- Pendant que la page reste ouverte et active, sa position GPS est
  transmise en direct au serveur, puis affichée sur `dashboard.html`
  (carte en temps réel façon "suivre mon bus"), avec le détail du trajet
  dans la popup du marqueur et la liste latérale.
- Le voyageur peut arrêter le partage ou retirer son consentement à tout
  moment ; toute transmission de position s'arrête immédiatement.

**Ce qui ne fonctionne PAS et ne peut pas fonctionner :**
- **Suivre un appareil éteint.** Un téléphone éteint n'émet aucun signal
  GPS, cellulaire ou Wi-Fi — il n'y a rien à capter. Aucune application,
  ici ou ailleurs, ne peut contourner cette limite physique sans matériel
  dédié (voir plus bas).
- **Suivre sans consentement.** Le serveur refuse toute position tant
  qu'un voyageur n'a pas explicitement accepté les conditions
  d'utilisation ; c'est appliqué côté serveur (`/api/consent`), pas
  seulement dans l'interface.
- **Suivre en arrière-plan à l'insu du voyageur.** Le partage s'arrête
  dès que la page est fermée (via `beforeunload` + `sendBeacon`) ou que
  l'onglet passe en veille prolongée sur certains navigateurs mobiles.
  Une vraie app native pourrait continuer quelques minutes en arrière-plan
  avec l'autorisation système "localisation en arrière-plan", mais cela
  reste visible pour l'utilisateur (icône de localisation active) et
  révocable dans les réglages de son téléphone.

Si le besoin réel est de suivre un véhicule même quand le téléphone du
voyageur est éteint ou absent, la seule solution technique est un
**traceur GPS autonome avec sa propre batterie**, installé dans le
véhicule — ce qui est justement le "capteur" que ce projet visait à
éviter. Les deux approches sont mutuellement exclusives.

## Architecture

```
voyageur-tracker/
├── server/
│   └── server.js       # Express + Socket.io, données en mémoire (Map JS)
├── public/
│   ├── passenger.html  # écran voyageur : consentement + partage
│   └── dashboard.html  # écran opérateur : carte en direct (Leaflet/OSM)
└── package.json
```

Flux de données :
1. `POST /api/consent` → crée un `traveler` seulement après acceptation
   explicite, retourne un `travelerId` stocké en local sur l'appareil.
2. `POST /api/trips` → ouvre un trajet (`tripId`) lié à ce voyageur, avec
   sa fiche (transport, agence, départ/arrivée, coût, véhicule, siège,
   heure prévue, notes). Refusé si le consentement a été retiré ou si un
   champ obligatoire manque.
3. `socket.emit('position:update', …)` → chaque position GPS captée par
   `navigator.geolocation.watchPosition`, revalidée côté serveur (trajet
   actif + consentement non retiré) avant stockage et diffusion.
4. Le dashboard rejoint la room `dashboard` et reçoit chaque
   `position:broadcast` en direct, plus l'état courant à la connexion.

## Lancer le prototype

```bash
npm install
npm start
# Serveur sur http://localhost:3000
```

- Écran voyageur : `http://localhost:3000/passenger.html`
- Tableau de bord opérateur : `http://localhost:3000/dashboard.html`

Ouvrez les deux dans des onglets/appareils différents pour voir le
marqueur bouger sur la carte au fur et à mesure que la position du
voyageur est mise à jour (déplacez-vous ou simulez la position via les
outils développeur du navigateur si vous testez depuis un poste fixe).

## Conformité et points à traiter avant une mise en production

Ce prototype pose les bases mais, pour un déploiement réel (Safetrip ou
autre), il reste à traiter :

- **Base légale et CGU définitives** : faire valider le texte de
  consentement par un juriste local (droit camerounais des données
  personnelles), en particulier sur la finalité exacte, la durée de
  conservation et les destinataires des données.
- **Authentification** : actuellement, `travelerId` est un identifiant
  simple stocké côté client — à sécuriser (session, token signé, ou
  compte lié à l'app Safetrip existante) avant toute donnée réelle.
- **Persistance réelle** : ce prototype garde tout en mémoire (`Map` JS)
  pour éviter d'imposer Python/outils de compilation au premier essai.
  Toutes les données sont perdues à chaque redémarrage du serveur. Pour
  la production, remplacer les `Map` de `server.js` par une vraie base
  (Postgres, MySQL, ou SQLite si Python/build tools sont disponibles sur
  la machine de déploiement).
- **Chiffrement en transit** : déployer derrière HTTPS/WSS, pas en HTTP
  simple comme dans ce prototype local.
- **Purge automatique** : ajouter une tâche planifiée qui supprime les
  positions au-delà de la durée de rétention annoncée (30 jours dans le
  texte de consentement, à ajuster).
- **Granularité du consentement** : si le produit final vise aussi les
  chauffeurs/flotte Safetrip plutôt que des passagers, le même schéma
  de consentement explicite s'applique à eux aussi — un employeur ne
  peut pas faire l'économie du consentement du salarié pour de la
  géolocalisation en dehors du cadre strictement professionnel défini
  par contrat.
- **Export/suppression sur demande** : prévoir un point d'accès pour
  qu'un voyageur obtienne ou efface son historique, au-delà de la simple
  révocation du partage futur.
