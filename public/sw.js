/* ═══════════════════════════════════════════════════════════
   PFT-AST Service Worker v4.5
   Handles: PWA caching + Web Push (works with screen OFF)
═══════════════════════════════════════════════════════════ */

const CACHE   = 'pft-ast-v5';
const SHELL   = ['/', '/pages/analyze.html', '/pages/history.html',
                  '/pages/alerts.html', '/app.css', '/app.js', '/config.js'];

// ── Install ───────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

// ── Activate ──────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch (cache-first for shell) ─────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })
      .catch(() => caches.match(e.request))
  );
});

/* ═══════════════════════════════════════════════════════════
   PUSH NOTIFICATION HANDLER
   This runs even when:
   - Phone screen is OFF
   - App is closed completely
   - Browser is in background
   Exactly like WhatsApp / SMS alerts
═══════════════════════════════════════════════════════════ */
self.addEventListener('push', e => {
  // Parse incoming payload from backend
  let d = {
    title:    '⚠ THREAT DETECTED',
    body:     'Acoustic threat detected by PFT-AST',
    url:      '/pages/alerts.html',
    tag:      'pft-threat',
    score:    null,
    source:   null,
    location: null,
    device:   null,
    risk:     'HIGH',
  };

  try {
    if (e.data) {
      const parsed = e.data.json();
      d = { ...d, ...parsed };
    }
  } catch (_) {}

  // Build rich notification body with all available info
  const lines = [d.body];
  if (d.score)    lines.push(`🎯 Score: ${d.score}`);
  if (d.source)   lines.push(`📡 Source: ${d.source}`);
  if (d.location) lines.push(`📍 ${d.location}`);
  if (d.device)   lines.push(`🖥 Device: ${d.device}`);

  const notifBody = lines.join('\n');

  // Vibration pattern: SOS-style for threat (long-short-long)
  const vibration = d.risk === 'HIGH'
    ? [500, 100, 500, 100, 500, 200, 100, 200, 100, 200, 500, 100, 500]  // SOS
    : [300, 100, 300];

  e.waitUntil(
    self.registration.showNotification(d.title, {
      body:               notifBody,
      icon:               '/icons/icon-192.png',
      badge:              '/icons/badge-72.png',
      tag:                d.tag,
      renotify:           true,          // Always re-show even if same tag
      requireInteraction: true,          // STAYS on screen until user taps
      silent:             false,         // Play sound
      vibrate:            vibration,
      timestamp:          Date.now(),
      data:               { url: d.url, score: d.score },
      actions: [
        { action: 'open',    title: '📊 Open Dashboard' },
        { action: 'history', title: '📋 View Analysis'  },
        { action: 'dismiss', title: '✕ Dismiss'         },
      ],
    })
  );
});

// ── Notification click handler ────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();

  let targetUrl = '/pages/alerts.html';
  if (e.action === 'open')    targetUrl = '/';
  if (e.action === 'history') targetUrl = '/pages/history.html';
  if (e.action === 'dismiss') return;

  // Get the configured backend URL from stored config
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Try to focus existing window first
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          c.navigate(targetUrl);
          return c.focus();
        }
      }
      // Open new window if none found
      return clients.openWindow(targetUrl);
    })
  );
});

// ── Push subscription change ──────────────────────────────
// Fires when browser refreshes the push subscription automatically
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe(e.oldSubscription.options)
      .then(sub => {
        // Re-register with backend
        return fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });
      })
      .catch(err => console.error('[SW] pushsubscriptionchange failed:', err))
  );
});
