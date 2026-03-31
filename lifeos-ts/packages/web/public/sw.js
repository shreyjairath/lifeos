// Service Worker for Web Push notifications

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'chief', body: event.data ? event.data.text() : 'New notification' };
  }

  const title = data.title || data.agentTitle || 'chief';
  const body = data.body || data.message || 'You have a new notification.';
  const urgency = data.urgency || 'low';

  const iconMap = {
    high: '/favicon.ico',
    medium: '/favicon.ico',
    low: '/favicon.ico',
  };

  const options = {
    body,
    icon: iconMap[urgency] || '/favicon.ico',
    badge: '/favicon.ico',
    tag: data.agent || 'chief-notification',
    data: {
      url: data.url || '/',
      agent: data.agent,
      urgency,
    },
    requireInteraction: urgency === 'high',
    vibrate: urgency === 'high' ? [200, 100, 200] : [100],
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
