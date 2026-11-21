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
// STOCKAGE : ce prototype garde tout en mémoire (aucune base de données
// à installer ou compiler). Les données sont perdues au redémarrage du
// serveur — c'est volontaire pour rester simple à faire tourner partout
// sans Python ni outils de compilation. Pour une mise en production,
// remplacer les Map ci-dessous par une vraie base (Postgres, MySQL…).

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const CONSENT_VERSION = '1.0-fr';

// --- "Base de données" en mémoire ---------------------------------------

const travelers = new Map(); // id -> { id, displayName, consentGivenAt, consentVersion, revokedAt }
const trips = new Map();     // id -> { id, travelerId, ...fiche, startedAt, endedAt }
const positionsByTrip = new Map(); // tripId -> [{ lat, lng, accuracyM, recordedAt }]

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Consentement -----------------------------------------------------

// Un voyageur doit explicitement accepter les CGU avant qu'un identifiant
// de suivi ne lui soit délivré. Rien n'est enregistré avant cet appel.
app.post('/api/consent', (req, res) => {
  const { displayName } = req.body;
  if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
    return res.status(400).json({ error: 'display_name_required' });
  }
  const id = crypto.randomUUID();
  travelers.set(id, {
    id,
    displayName: displayName.trim(),
    consentGivenAt: new Date().toISOString(),
    consentVersion: CONSENT_VERSION,
    revokedAt: null,
  });

  res.json({ travelerId: id, consentVersion: CONSENT_VERSION });
});

// Révocation : le voyageur peut retirer son consentement à tout moment.
// Toute position future est refusée ; l'historique déjà enregistré reste
// soumis à la politique de rétention (voir README).
app.post('/api/consent/:travelerId/revoke', (req, res) => {
  const { travelerId } = req.params;
  const traveler = travelers.get(travelerId);
  if (!traveler) return res.status(404).json({ error: 'not_found' });

  traveler.revokedAt = new Date().toISOString();

  for (const trip of trips.values()) {
    if (trip.travelerId === travelerId && !trip.endedAt) {
      trip.endedAt = new Date().toISOString();
    }
  }

  res.json({ ok: true });
});

// --- Trajets ------------------------------------------------------------

app.post('/api/trips', (req, res) => {
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

  const traveler = travelers.get(travelerId);
  if (!traveler) return res.status(404).json({ error: 'unknown_traveler' });
  if (traveler.revokedAt) return res.status(403).json({ error: 'consent_revoked' });

  // Le moyen de transport, le départ et l'arrivée sont les seuls champs
  // jugés indispensables pour qu'un suivi ait un sens opérationnel ;
  // le reste reste facultatif pour ne pas bloquer un voyageur pressé.
  if (!transportMode || !originLabel || !destinationLabel) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  const tripId = crypto.randomUUID();
  trips.set(tripId, {
    id: tripId,
    travelerId,
    lineLabel: lineLabel || null,
    transportMode,
    agencyName: agencyName || null,
    originLabel,
    destinationLabel,
    fareAmount: typeof fareAmount === 'number' ? fareAmount : null,
    fareCurrency: fareCurrency || 'XAF',
    vehiclePlate: vehiclePlate || null,
    seatNumber: seatNumber || null,
    scheduledDepartureAt: scheduledDepartureAt || null,
    notes: notes || null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  });
  positionsByTrip.set(tripId, []);

  res.json({ tripId });
});

app.post('/api/trips/:tripId/end', (req, res) => {
  const { tripId } = req.params;
  const trip = trips.get(tripId);
  if (trip) trip.endedAt = new Date().toISOString();
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server);

function broadcastPayload(trip, traveler, position) {
  return {
    tripId: trip.id,
    travelerDisplayName: traveler.displayName,
    lineLabel: trip.lineLabel,
    transportMode: trip.transportMode,
    agencyName: trip.agencyName,
    originLabel: trip.originLabel,
    destinationLabel: trip.destinationLabel,
    fareAmount: trip.fareAmount,
    fareCurrency: trip.fareCurrency,
    vehiclePlate: trip.vehiclePlate,
    seatNumber: trip.seatNumber,
    scheduledDepartureAt: trip.scheduledDepartureAt,
    notes: trip.notes,
    lat: position.lat,
    lng: position.lng,
    accuracyM: position.accuracyM,
    recordedAt: position.recordedAt,
  };
}

// position:update — reçu uniquement pendant une trip active avec consentement
// valide. Rejeté sinon.
io.on('connection', (socket) => {
  socket.on('position:update', (msg, ack) => {
    const { tripId, lat, lng, accuracyM } = msg || {};
    if (!tripId || typeof lat !== 'number' || typeof lng !== 'number') {
      if (ack) ack({ ok: false, error: 'bad_payload' });
      return;
    }

    const trip = trips.get(tripId);
    if (!trip || trip.endedAt) {
      if (ack) ack({ ok: false, error: 'trip_not_active' });
      return;
    }
    const traveler = travelers.get(trip.travelerId);
    if (!traveler || traveler.revokedAt) {
      if (ack) ack({ ok: false, error: 'consent_revoked' });
      return;
    }

    const position = {
      lat,
      lng,
      accuracyM: accuracyM || null,
      recordedAt: new Date().toISOString(),
    };
    positionsByTrip.get(tripId).push(position);

    io.to('dashboard').emit('position:broadcast', broadcastPayload(trip, traveler, position));

    if (ack) ack({ ok: true });
  });

  socket.on('dashboard:join', () => {
    socket.join('dashboard');

    // Envoie l'état actuel (dernière position connue par trip active)
    for (const trip of trips.values()) {
      if (trip.endedAt) continue;
      const traveler = travelers.get(trip.travelerId);
      if (!traveler || traveler.revokedAt) continue;

      const positions = positionsByTrip.get(trip.id) || [];
      const last = positions[positions.length - 1];
      if (last) {
        socket.emit('position:broadcast', broadcastPayload(trip, traveler, last));
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Voyageur Tracker (prototype) sur http://localhost:${PORT}`);
});
