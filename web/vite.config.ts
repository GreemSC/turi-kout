import { createHash } from 'node:crypto';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

/**
 * Genere le service worker au moment du build, avec la liste exacte des
 * fichiers hashes a precacher. Evite d'embarquer Workbox pour ce seul besoin :
 * le budget est de 150 ko compresses (critere d'acceptation 8).
 */
function serviceWorker(): Plugin {
  return {
    name: 'turi-kout-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => !name.endsWith('.map'))
        .map((name) => `/${name}`);

      const shell = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', ...assets];
      const version = createHash('sha256').update(shell.join('|')).digest('hex').slice(0, 12);

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: swSource(version, [...new Set(shell)]),
      });
    },
  };
}

function swSource(version: string, shell: string[]): string {
  return `// Genere par vite.config.ts — ne pas editer.
const VERSION = ${JSON.stringify(version)};
const SHELL = ${JSON.stringify(shell)};
${SW_BODY}`;
}

// Corps du service worker. Strategie cache-first sur le shell (section 3.1),
// reseau seul pour /api : les donnees vivent dans IndexedDB, pas dans le cache
// HTTP, et une reponse d'API perimee serait pire que pas de reponse du tout.
const SW_BODY = String.raw`
const CACHE = 'turi-kout-' + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Navigation hors ligne vers une route jamais visitee : on rend le shell.
          if (request.mode === 'navigate') return caches.match('/index.html');
          throw new Error('offline');
        });
    }),
  );
});

// --- Minuteur de repos (section 5.5) ---------------------------------------
// La page delegue la fin du minuteur au service worker : il survit a la mise en
// arriere-plan de l'onglet, ce qu'un setTimeout de page ne garantit pas.
let restTimer = null;

self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'rest:start') {
    clearTimeout(restTimer);
    const delay = Math.max(0, data.endsAt - Date.now());
    restTimer = setTimeout(() => {
      restTimer = null;
      self.registration.showNotification('Repos terminé', {
        body: data.label || 'Série suivante.',
        tag: 'turi-kout-rest',
        renotify: true,
        vibrate: [200, 100, 200, 100, 400],
        silent: false,
        requireInteraction: false,
      });
    }, delay);
  }

  if (data.type === 'rest:cancel') {
    clearTimeout(restTimer);
    restTimer = null;
    self.registration.getNotifications({ tag: 'turi-kout-rest' })
      .then((list) => list.forEach((n) => n.close()));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.includes(self.location.origin));
      if (open) return open.focus();
      return self.clients.openWindow('/');
    }),
  );
});
`;

export default defineConfig({
  plugins: [svelte(), serviceWorker()],
  build: {
    target: 'es2022',
    // Un seul chunk : l'application est petite et se charge en 4G faible, les
    // aller-retours de chargement coutent plus cher que quelques ko.
    modulePreload: { polyfill: false },
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080' },
  },
});
