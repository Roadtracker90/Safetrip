// Safetrip Voyageur Tracker — prototype
//
// PRINCIPE DE CONCEPTION : ce service ne peut suivre un voyageur que
// pendant que (a) son appareil est allumé, (b) il a explicitement donné
// son consentement, et (c) le partage de position est actif (il peut
// l'arrêter à tout moment). Il n'existe AUCUN mécanisme de suivi d'un
// appareil éteint ou sans consentement — ce n'est pas une limitation
// de ce code, c'est une limitation physique (un appareil éteint
// n'émet aucun signal).
//
// STOCKAGE : PostgreSQL, via le module "pg" (JavaScript pur, aucune
// compilation native requise — contrairement à better-sqlite3). Les
// données survivent donc aux redémarrages du serveur (redéploiement,
// réveil après mise en veille du plan gratuit Render, etc.), à
// condition que DATABASE_URL pointe vers une vraie base externe.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const webpush = require('web-push');

const CONSENT_VERSION = '1.0-fr';

// --- Notifications push (dashboard opérateur) ---------------------------
// Clés VAPID : identifient ce serveur auprès des services de push des
// navigateurs (gratuit, aucun compte tiers requis). Elles doivent rester
// STABLES d'un redéploiement à l'autre (sinon les abonnements existants
// deviennent invalides) : définissez-les en variables d'environnement sur
// Render plutôt que de laisser le serveur en générer de nouvelles à chaque
// démarrage. Sans ces variables, les notifications push sont simplement
// désactivées — le reste de l'application continue de fonctionner.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@example.com';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.log('Notifications push désactivées (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY non définies).');
}

// --- Protection du dashboard opérateur -----------------------------------
// Mot de passe partagé optionnel (Basic Auth) : si OPERATOR_PASSWORD est
// défini, dashboard.html n'est accessible qu'après l'avoir saisi. Sans
// cette variable, le dashboard reste ouvert (comportement d'avant, pour ne
// pas bloquer un déploiement existant tant que le mot de passe n'a pas été
// configuré côté Render).
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD;
function requireOperatorAuth(req, res, next) {
  if (!OPERATOR_PASSWORD) return next();
  const header = req.headers.authorization || '';
  const [, encoded] = header.split(' ');
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const [, pass] = decoded.split(':');
  if (pass === OPERATOR_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="Safetrip opérateur"');
  res.status(401).send('Authentification requise.');
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERREUR : la variable d\'environnement DATABASE_URL est manquante.');
  console.error('Définissez-la (ex: postgres://user:pass@host:5432/dbname) avant de démarrer.');
  process.exit(1);
}

// Render (et la plupart des hébergeurs) exigent TLS sur la connexion
// externe, mais une base locale (tests sur votre machine) n'en a pas.
const isLocalDb = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS travelers (
      id UUID PRIMARY KEY,
      display_name TEXT NOT NULL,
      consent_given_at TIMESTAMPTZ NOT NULL,
      consent_version TEXT NOT NULL,
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS trips (
      id UUID PRIMARY KEY,
      traveler_id UUID NOT NULL REFERENCES travelers(id),
      line_label TEXT,
      transport_mode TEXT,
      agency_name TEXT,
      origin_label TEXT,
      destination_label TEXT,
      fare_amount NUMERIC,
      fare_currency TEXT,
      vehicle_plate TEXT,
      seat_number TEXT,
      scheduled_departure_at TIMESTAMPTZ,
      notes TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS positions (
      id BIGSERIAL PRIMARY KEY,
      trip_id UUID NOT NULL REFERENCES trips(id),
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      accuracy_m DOUBLE PRECISION,
      recorded_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_positions_trip ON positions(trip_id);

    CREATE TABLE IF NOT EXISTS alerts (
      id BIGSERIAL PRIMARY KEY,
      trip_id UUID NOT NULL REFERENCES trips(id),
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL,
      cleared_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_trip ON alerts(trip_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);

  // La table "trips" existe déjà en production (données déjà présentes) :
  // CREATE TABLE IF NOT EXISTS ne touche pas une table déjà créée, donc les
  // nouvelles colonnes doivent être ajoutées explicitement.
  await pool.query(`
    ALTER TABLE trips ADD COLUMN IF NOT EXISTS alert_active BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_alert_at TIMESTAMPTZ;
    ALTER TABLE trips ADD COLUMN IF NOT EXISTS vehicle_alert_count INTEGER NOT NULL DEFAULT 0;
  `);
}

// --- Rétention des données -----------------------------------------------
// Les CGU affichées au voyageur promettent une conservation de 30 jours.
// Purge quotidienne des trajets terminés depuis plus de 30 jours (et de
// leurs positions/alertes liées) ; un trajet actif n'est jamais purgé.
const RETENTION_DAYS = 30;
async function purgeOldData() {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM trips WHERE ended_at IS NOT NULL AND ended_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );
    if (!rows.length) return;
    const ids = rows.map((r) => r.id);
    await pool.query('DELETE FROM alerts WHERE trip_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM positions WHERE trip_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM trips WHERE id = ANY($1)', [ids]);
    console.log(`Purge rétention : ${ids.length} trajet(s) de plus de ${RETENTION_DAYS} jours supprimé(s).`);
  } catch (err) {
    console.error('Erreur de purge rétention :', err);
  }
}

const app = express();
app.use(express.json());

// Nettoyage des liens copiés-collés depuis des sources en texte enrichi
// (WhatsApp, Word, Google Docs, certains claviers avec correction
// automatique) : ces applications insèrent parfois un caractère Unicode
// invisible (espaces/joints de largeur nulle, "function application",
// BOM...) juste après l'URL copiée. Le navigateur l'envoie tel quel,
// Express ne trouve alors aucune route correspondante et répond
// "Cannot GET ...". On retire ces caractères avant le routage, pour
// qu'un lien partagé fonctionne même s'il a été "sali" en chemin.
app.use((req, res, next) => {
  const cleaned = req.url.replace(/[​-‏⁠-⁤﻿]/g, '');
  if (cleaned !== req.url) req.url = cleaned;
  next();
});

// Le dashboard opérateur est protégé en amont du serveur de fichiers
// statiques, sinon express.static servirait la page avant la vérification.
//
// Le mot de passe est vérifié une fois, ici, via l'authentification Basic du
// navigateur — mais la page a ensuite besoin d'un socket.io authentifié pour
// recevoir les trajets en direct, et le mot de passe lui-même ne doit jamais
// être exposé au JavaScript de la page. On lui injecte donc un jeton
// aléatoire à usage unique (valable le temps de la session de ce socket),
// généré ici puisque cette route a déjà vérifié le mot de passe.
const operatorTokens = new Set();
app.get('/dashboard.html', requireOperatorAuth, async (req, res) => {
  let html = await require('fs').promises.readFile(path.join(__dirname, 'dashboard.html'), 'utf8');
  const token = crypto.randomUUID();
  operatorTokens.add(token);
  // Un jeton ne doit pas s'accumuler indéfiniment si la page est rechargée
  // souvent sans jamais se connecter en socket : on le laisse expirer seul.
  setTimeout(() => operatorTokens.delete(token), 10 * 60 * 1000);
  html = html.replace('__OPERATOR_TOKEN__', token);
  res.set('Content-Type', 'text/html').send(html);
});
app.use(express.static(__dirname));

app.get('/api/push/public-key', (req, res) => {
  res.json({ enabled: PUSH_ENABLED, publicKey: VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', requireOperatorAuth, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad_subscription' });
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, subscription, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (endpoint) DO UPDATE SET subscription = EXCLUDED.subscription`,
    [sub.endpoint, sub]
  );
  res.json({ ok: true });
});

async function sendPushToDashboard(title, body, tripId) {
  if (!PUSH_ENABLED) return;
  try {
    const { rows } = await pool.query('SELECT endpoint, subscription FROM push_subscriptions');
    const payload = JSON.stringify({ title, body, tripId });
    await Promise.all(rows.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, payload);
      } catch (err) {
        // Abonnement expiré/révoqué (410/404) : on le retire silencieusement.
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint]);
        } else {
          console.error('Échec envoi push', err.statusCode || err.message);
        }
      }
    }));
  } catch (err) {
    console.error('sendPushToDashboard error', err);
  }
}

// Point de contrôle léger (aucune requête base de données) pour un service
// externe de "ping" anti-veille (ex. UptimeRobot, cron-job.org) — appelé
// toutes les quelques minutes, ça empêche le plan gratuit Render de mettre
// le service en veille, donc d'éviter le délai de réveil de 30-60s.
app.get('/health', (req, res) => res.status(200).send('ok'));

// --- Consentement -----------------------------------------------------

// Un voyageur doit explicitement accepter les CGU avant qu'un identifiant
// de suivi ne lui soit délivré. Rien n'est enregistré avant cet appel.
app.post('/api/consent', async (req, res) => {
  const { displayName } = req.body;
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'display_name_required' });
  }
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO travelers (id, display_name, consent_given_at, consent_version)
     VALUES ($1, $2, NOW(), $3)`,
    [id, displayName.trim(), CONSENT_VERSION]
  );

  res.json({ travelerId: id, consentVersion: CONSENT_VERSION });
});

// Révocation : le voyageur peut retirer son consentement à tout moment.
// Toute position future est refusée ; l'historique déjà enregistré reste
// soumis à la politique de rétention (voir README).
app.post('/api/consent/:travelerId/revoke', async (req, res) => {
  const { travelerId } = req.params;
  const { rows } = await pool.query('SELECT id FROM travelers WHERE id = $1', [travelerId]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });

  await pool.query('UPDATE travelers SET revoked_at = NOW() WHERE id = $1', [travelerId]);
  await pool.query(
    'UPDATE trips SET ended_at = NOW() WHERE traveler_id = $1 AND ended_at IS NULL',
    [travelerId]
  );

  res.json({ ok: true });
});

// --- Trajets ------------------------------------------------------------

app.post('/api/trips', async (req, res) => {
  const {
    travelerId,
    lineLabel,
    transportMode,
    agencyName,
    originLabel,
    destinationLabel,
    fareAmount,
    fareCurrency,
    vehiclePlate,
    seatNumber,
    scheduledDepartureAt,
    notes,
  } = req.body;

  const { rows } = await pool.query('SELECT * FROM travelers WHERE id = $1', [travelerId]);
  const traveler = rows[0];
  if (!traveler) return res.status(404).json({ error: 'unknown_traveler' });
  if (traveler.revoked_at) return res.status(403).json({ error: 'consent_revoked' });

  // Le moyen de transport, le départ et l'arrivée sont les seuls champs
  // jugés indispensables pour qu'un suivi ait un sens opérationnel ;
  // le reste reste facultatif pour ne pas bloquer un voyageur pressé.
  if (!transportMode || !originLabel || !destinationLabel) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  // Historique du véhicule : nombre d'alertes déjà déclenchées sur des
  // trajets ayant utilisé la même immatriculation (sécurité collective —
  // signale à l'opérateur un véhicule déjà associé à un incident).
  let vehicleAlertCount = 0;
  const plateNormalized = (vehiclePlate || '').trim().toUpperCase();
  if (plateNormalized) {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS n FROM alerts a
       JOIN trips t ON t.id = a.trip_id
       WHERE UPPER(TRIM(t.vehicle_plate)) = $1`,
      [plateNormalized]
    );
    vehicleAlertCount = parseInt(countRows[0].n, 10) || 0;
  }

  const tripId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO trips (
       id, traveler_id, line_label, transport_mode, agency_name,
       origin_label, destination_label, fare_amount, fare_currency,
       vehicle_plate, seat_number, scheduled_departure_at, notes, started_at,
       vehicle_alert_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), $14)`,
    [
      tripId,
      travelerId,
      lineLabel || null,
      transportMode,
      agencyName || null,
      originLabel,
      destinationLabel,
      typeof fareAmount === 'number' ? fareAmount : null,
      fareCurrency || 'XAF',
      vehiclePlate || null,
      seatNumber || null,
      scheduledDepartureAt || null,
      notes || null,
      vehicleAlertCount,
    ]
  );

  res.json({ tripId, vehicleAlertCount });
});

app.post('/api/trips/:tripId/end', async (req, res) => {
  const { tripId } = req.params;
  const { rows } = await pool.query(
    'UPDATE trips SET ended_at = NOW() WHERE id = $1 RETURNING ended_at',
    [tripId]
  );
  if (rows[0]) {
    io.to(`trip:${tripId}`).emit('track:ended', { endedAt: rows[0].ended_at });
  }
  res.json({ ok: true });
});

// --- Alerte d'urgence ---------------------------------------------------
//
// Bouton "panique" du voyageur : déclenche immédiatement une alerte visible
// sur le dashboard opérateur ET sur tout lien de partage actif pour ce
// trajet, avec la dernière position connue. Ne nécessite aucun champ
// obligatoire en plus du consentement/trajet déjà actifs.
app.post('/api/trips/:tripId/alert', async (req, res) => {
  const { tripId } = req.params;
  const { lat, lng } = req.body || {};

  const { rows: tripRows } = await pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
  const trip = tripRows[0];
  if (!trip || trip.ended_at) return res.status(404).json({ error: 'trip_not_active' });

  const { rows: travelerRows } = await pool.query(
    'SELECT * FROM travelers WHERE id = $1',
    [trip.traveler_id]
  );
  const traveler = travelerRows[0];
  if (!traveler || traveler.revoked_at) return res.status(403).json({ error: 'consent_revoked' });

  await pool.query(
    `INSERT INTO alerts (trip_id, lat, lng, created_at) VALUES ($1, $2, $3, NOW())`,
    [tripId, typeof lat === 'number' ? lat : null, typeof lng === 'number' ? lng : null]
  );
  const { rows: updated } = await pool.query(
    `UPDATE trips SET alert_active = true, last_alert_at = NOW() WHERE id = $1 RETURNING last_alert_at`,
    [tripId]
  );

  const payload = {
    tripId,
    travelerDisplayName: traveler.display_name,
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
    at: updated[0].last_alert_at,
  };
  io.to('dashboard').emit('trip:alert', payload);
  io.to(`trip:${tripId}`).emit('trip:alert', payload);
  sendPushToDashboard(
    '🆘 Alerte Safetrip',
    `${traveler.display_name} a déclenché une alerte d'urgence.`,
    tripId
  );

  res.json({ ok: true });
});

// L'opérateur (dashboard) marque l'alerte comme traitée. Le voyageur peut
// toujours redéclencher une nouvelle alerte ensuite si besoin.
app.post('/api/trips/:tripId/alert/clear', requireOperatorAuth, async (req, res) => {
  const { tripId } = req.params;
  await pool.query('UPDATE trips SET alert_active = false WHERE id = $1', [tripId]);
  await pool.query(
    'UPDATE alerts SET cleared_at = NOW() WHERE trip_id = $1 AND cleared_at IS NULL',
    [tripId]
  );
  io.to('dashboard').emit('trip:alert:cleared', { tripId });
  io.to(`trip:${tripId}`).emit('trip:alert:cleared', { tripId });
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server);

function broadcastPayload(trip, traveler, position) {
  return {
    tripId: trip.id,
    travelerDisplayName: traveler.display_name,
    lineLabel: trip.line_label,
    transportMode: trip.transport_mode,
    agencyName: trip.agency_name,
    originLabel: trip.origin_label,
    destinationLabel: trip.destination_label,
    fareAmount: trip.fare_amount != null ? Number(trip.fare_amount) : null,
    fareCurrency: trip.fare_currency,
    vehiclePlate: trip.vehicle_plate,
    seatNumber: trip.seat_number,
    scheduledDepartureAt: trip.scheduled_departure_at,
    notes: trip.notes,
    lat: position.lat,
    lng: position.lng,
    accuracyM: position.accuracy_m,
    recordedAt: position.recorded_at,
    alertActive: !!trip.alert_active,
    lastAlertAt: trip.last_alert_at,
    vehicleAlertCount: trip.vehicle_alert_count || 0,
  };
}

// --- Détection de perte de signal ----------------------------------------
// Repère automatiquement un trajet actif qui n'a transmis aucune position
// depuis trop longtemps (téléphone à plat, zone sans réseau, application
// fermée...) et le signale à l'opérateur SANS action du voyageur — complète
// le bouton d'alerte manuel pour les cas où il ne peut justement plus agir.
// État en mémoire seulement (redémarrage du serveur = remise à zéro, ce qui
// est acceptable pour un signal "best effort" non critique pour les données).
const SIGNAL_LOST_MS = (parseFloat(process.env.SIGNAL_LOST_MINUTES) || 5) * 60 * 1000;
const SIGNAL_CHECK_MS = parseInt(process.env.SIGNAL_CHECK_MS, 10) || 60 * 1000;
const lastSeenAt = new Map();      // tripId -> timestamp ms de la dernière position reçue
const signalLostTrips = new Set(); // tripId déjà signalés (évite le spam)

setInterval(async () => {
  try {
    const { rows: active } = await pool.query(`
      SELECT t.id, t.started_at, tr.display_name
      FROM trips t JOIN travelers tr ON tr.id = t.traveler_id
      WHERE t.ended_at IS NULL AND tr.revoked_at IS NULL
    `);
    const activeIds = new Set(active.map((r) => r.id));
    for (const id of [...lastSeenAt.keys()]) if (!activeIds.has(id)) lastSeenAt.delete(id);
    for (const id of [...signalLostTrips]) if (!activeIds.has(id)) signalLostTrips.delete(id);

    const now = Date.now();
    for (const trip of active) {
      const baseline = lastSeenAt.get(trip.id) || new Date(trip.started_at).getTime();
      const silentMs = now - baseline;
      if (silentMs > SIGNAL_LOST_MS && !signalLostTrips.has(trip.id)) {
        signalLostTrips.add(trip.id);
        const payload = {
          tripId: trip.id,
          travelerDisplayName: trip.display_name,
          silentForMinutes: Math.round(silentMs / 60000),
        };
        io.to('dashboard').emit('trip:signal_lost', payload);
        io.to(`trip:${trip.id}`).emit('trip:signal_lost', payload);
        sendPushToDashboard(
          '⚠️ Signal perdu',
          `${trip.display_name} : plus de position depuis ${payload.silentForMinutes} min.`,
          trip.id
        );
      }
    }
  } catch (err) {
    console.error('Erreur détection signal perdu :', err);
  }
}, SIGNAL_CHECK_MS);

// position:update — reçu uniquement pendant une trip active avec consentement
// valide. Rejeté sinon.
io.on('connection', (socket) => {
  socket.on('position:update', async (msg, ack) => {
    try {
      const { tripId, lat, lng, accuracyM } = msg || {};
      if (!tripId || typeof lat !== 'number' || typeof lng !== 'number') {
        if (ack) ack({ ok: false, error: 'bad_payload' });
        return;
      }

      const { rows: tripRows } = await pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
      const trip = tripRows[0];
      if (!trip || trip.ended_at) {
        if (ack) ack({ ok: false, error: 'trip_not_active' });
        return;
      }
      const { rows: travelerRows } = await pool.query(
        'SELECT * FROM travelers WHERE id = $1',
        [trip.traveler_id]
      );
      const traveler = travelerRows[0];
      if (!traveler || traveler.revoked_at) {
        if (ack) ack({ ok: false, error: 'consent_revoked' });
        return;
      }

      const { rows: posRows } = await pool.query(
        `INSERT INTO positions (trip_id, lat, lng, accuracy_m, recorded_at)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
        [tripId, lat, lng, accuracyM || null]
      );
      const position = posRows[0];

      lastSeenAt.set(tripId, Date.now());
      if (signalLostTrips.has(tripId)) {
        signalLostTrips.delete(tripId);
        io.to('dashboard').emit('trip:signal_restored', { tripId });
        io.to(`trip:${tripId}`).emit('trip:signal_restored', { tripId });
      }

      const payload = broadcastPayload(trip, traveler, position);
      io.to('dashboard').emit('position:broadcast', payload);
      // Diffusion scopée : seuls les sockets qui suivent CE trajet précis
      // (via un lien de partage) la reçoivent — jamais les autres trajets.
      io.to(`trip:${tripId}`).emit('position:broadcast', payload);

      if (ack) ack({ ok: true });
    } catch (err) {
      console.error('position:update error', err);
      if (ack) ack({ ok: false, error: 'server_error' });
    }
  });

  // Suivi par lien de partage : un contact qui ouvre track.html?trip=<id>
  // ne rejoint QUE la room de ce trajet précis, jamais la vue globale du
  // dashboard opérateur. Refusé si le trajet n'existe plus ou que le
  // consentement a été retiré entre-temps.
  socket.on('track:join', async (msg) => {
    try {
      const { tripId } = msg || {};
      const { rows: tripRows } = await pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
      const trip = tripRows[0];
      const { rows: travelerRows } = trip
        ? await pool.query('SELECT * FROM travelers WHERE id = $1', [trip.traveler_id])
        : { rows: [] };
      const traveler = travelerRows[0];

      if (!trip || !traveler || traveler.revoked_at) {
        socket.emit('track:error', { error: 'trip_unavailable' });
        return;
      }

      socket.join(`trip:${tripId}`);

      const { rows: posRows } = await pool.query(
        'SELECT * FROM positions WHERE trip_id = $1 ORDER BY id DESC LIMIT 1',
        [tripId]
      );
      if (posRows[0]) {
        socket.emit('position:broadcast', broadcastPayload(trip, traveler, posRows[0]));
      }
      if (trip.ended_at) {
        socket.emit('track:ended', { endedAt: trip.ended_at });
      }
    } catch (err) {
      console.error('track:join error', err);
      socket.emit('track:error', { error: 'server_error' });
    }
  });

  socket.on('dashboard:join', async (msg) => {
    // Le navigateur garde le mot de passe pour lui (Basic Auth) ; la page
    // ne connaît qu'un jeton à usage temporaire reçu quand elle a été
    // servie avec les bons identifiants (voir la route /dashboard.html).
    if (OPERATOR_PASSWORD && (!msg || !operatorTokens.has(msg.token))) {
      socket.emit('dashboard:unauthorized');
      return;
    }
    socket.join('dashboard');

    try {
      const { rows: activeTrips } = await pool.query(`
        SELECT t.*, tr.display_name
        FROM trips t JOIN travelers tr ON tr.id = t.traveler_id
        WHERE t.ended_at IS NULL AND tr.revoked_at IS NULL
      `);

      for (const trip of activeTrips) {
        const { rows: posRows } = await pool.query(
          'SELECT * FROM positions WHERE trip_id = $1 ORDER BY id DESC LIMIT 1',
          [trip.id]
        );
        const last = posRows[0];
        if (last) {
          socket.emit(
            'position:broadcast',
            broadcastPayload(trip, { display_name: trip.display_name }, last)
          );
        }
      }
    } catch (err) {
      console.error('dashboard:join error', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Voyageur Tracker (prototype) sur http://localhost:${PORT}`);
    });
    purgeOldData();
    setInterval(purgeOldData, 24 * 60 * 60 * 1000);
  })
  .catch((err) => {
    console.error('Échec d\'initialisation de la base de données :', err);
    process.exit(1);
  });
