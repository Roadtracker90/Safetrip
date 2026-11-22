// Fretchain Voyageur Tracker — prototype
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

const CONSENT_VERSION = '1.0-fr';

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
  `);
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

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

  const tripId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO trips (
       id, traveler_id, line_label, transport_mode, agency_name,
       origin_label, destination_label, fare_amount, fare_currency,
       vehicle_plate, seat_number, scheduled_departure_at, notes, started_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())`,
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
    ]
  );

  res.json({ tripId });
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
  };
}

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

  socket.on('dashboard:join', async () => {
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
  })
  .catch((err) => {
    console.error('Échec d\'initialisation de la base de données :', err);
    process.exit(1);
  });
