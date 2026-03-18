/* PFT-AST Service Worker v3 */
const CACHE = 'pft-ast-v3';
const PRECACHE = ['/', '/pages/analyze.html', '/pages/history.html', '/pages/alerts.html'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(()=>{})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

/* ── Push Notification ── */
self.addEventListener('push', e => {
  let d = { title: '⚠ Threat Alert', body: 'Acoustic threat detected!', url: '/', tag: 'threat' };
  try { if (e.data) d = { ...d, ...e.data.json() }; } catch(_) {}

  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: d.tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 100, 300, 100, 600],
    data: { url: d.url },
    actions: [
      { action: 'open',    title: '📊 Open Dashboard' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return clients.openWindow(url);
    })
  );
});
