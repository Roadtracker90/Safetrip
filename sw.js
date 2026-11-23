// Service worker du dashboard opérateur Safetrip — gère uniquement les
// notifications push (alerte d'urgence / signal perdu). Ne met rien en
// cache : le dashboard doit toujours afficher les trajets les plus
// récents, jamais une version hors-ligne périmée.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Safetrip', body: 'Nouvelle alerte.' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    // payload non-JSON : on garde le message par défaut
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Safetrip', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tripId || undefined,
      requireInteraction: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('dashboard.html') && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/dashboard.html');
    })
  );
});
