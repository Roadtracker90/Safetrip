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
- Une fois le partage démarré, le voyageur obtient aussi un **lien de
  suivi individuel** (`track.html?trip=<id>`) qu'il peut copier ou
  partager via le bouton natif de partage du téléphone (WhatsApp, SMS,
  etc.). Ce lien ne montre que ce trajet précis, jamais les autres
  trajets actifs sur la plateforme — contrairement au dashboard
  opérateur. Il cesse de fonctionner dès que le trajet est arrêté ou le
  consentement retiré.
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
├── server.js       # Express + Socket.io + PostgreSQL (module "pg")
├── passenger.html  # écran voyageur : consentement, fiche de trajet, partage
├── dashboard.html  # écran opérateur : carte en direct (Leaflet/OSM)
├── track.html      # lien de suivi individuel (un seul trajet)
└── package.json
```

Les données (voyageurs, trajets, positions) sont stockées dans PostgreSQL
— elles survivent donc aux redémarrages du serveur (redéploiement, réveil
après mise en veille sur le plan gratuit Render, etc.). Le serveur lit
l'adresse de la base dans la variable d'environnement `DATABASE_URL` et
crée les tables nécessaires automatiquement au démarrage s'il ne les
trouve pas (`CREATE TABLE IF NOT EXISTS`).

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

Il faut une base PostgreSQL accessible (locale pour tester, ou celle
fournie par votre hébergeur en production) et définir `DATABASE_URL` :

```bash
npm install
DATABASE_URL="postgres://utilisateur:motdepasse@hote:5432/nom_de_base" npm start
# Serveur sur http://localhost:3000
```

Sous Windows (PowerShell) :
```powershell
$env:DATABASE_URL="postgres://utilisateur:motdepasse@hote:5432/nom_de_base"
npm start
```

Sur Render, `DATABASE_URL` se configure dans l'onglet **Environment** du
service (voir plus bas) — pas besoin de la taper à la main à chaque fois.

- Écran voyageur : `http://localhost:3000/passenger.html`
- Tableau de bord opérateur : `http://localhost:3000/dashboard.html`
- Lien de suivi individuel (généré automatiquement après démarrage d'un
  trajet voyageur) : `http://localhost:3000/track.html?trip=<tripId>`

Ouvrez les deux dans des onglets/appareils différents pour voir le
marqueur bouger sur la carte au fur et à mesure que la position du
voyageur est mise à jour (déplacez-vous ou simulez la position via les
outils développeur du navigateur si vous testez depuis un poste fixe).

## Fiabilité sur réseau mobile et plan gratuit Render

Deux soucis observés en test (page qui n'affiche rien sur certains Android,
écran noir bloqué sur iPhone) et comment ce projet les traite :

- **Mise en veille du plan gratuit Render** : après ~15 minutes sans
  trafic, le service s'endort et met 30 à 60 secondes à se réveiller à la
  requête suivante. Pendant ce délai, un navigateur peut afficher un écran
  vide (noir en mode sombre sur iOS, le temps que la page arrive). Ce
  n'est pas un bug du code, mais une caractéristique du plan gratuit.
  **Solution recommandée** : configurer un service externe gratuit
  (UptimeRobot, cron-job.org) pour appeler `https://votre-service.onrender.com/health`
  toutes les 5 à 10 minutes — ça garde le service éveillé en permanence.
  Cette route ne fait aucune requête à la base de données, donc elle
  répond instantanément même si le reste de l'app est sous tension.
- **Dépendance à un CDN externe (unpkg.com)** : corrigé. Les fichiers de
  la bibliothèque de cartes (Leaflet) sont maintenant servis directement
  par ce serveur (`/vendor/leaflet/`) plutôt que depuis unpkg.com, qui
  pouvait être lent ou bloqué sur certains réseaux mobiles/opérateurs.
  Seules les tuiles de carte elles-mêmes (l'image de fond de carte)
  viennent encore d'OpenStreetMap, un service beaucoup plus largement
  accessible.
- **Dégradation progressive** : si la carte ne peut toujours pas se
  charger (réseau très instable), les 3 pages continuent de fonctionner
  sans elle — `passenger.html` transmet la position normalement avec un
  message explicite à la place de la carte, `dashboard.html` garde sa
  liste latérale à jour, `track.html` affiche les informations du trajet
  en texte. Avant, une erreur sur la carte pouvait bloquer toute la page.
- **Premier affichage toujours clair** : un fond clair est maintenant
  forcé dès le chargement initial (avant même que le CSS complet soit
  appliqué), pour éviter l'écran noir que montre iOS en mode sombre tant
  qu'une page n'a encore rien affiché.

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
- **Sauvegardes et plan de reprise** : la persistance PostgreSQL résout la
  perte de données au redémarrage, mais pas une panne de la base
  elle-même — prévoir des sauvegardes régulières (la plupart des
  hébergeurs, dont Render, proposent des sauvegardes automatiques sur
  leurs plans PostgreSQL payants).
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
