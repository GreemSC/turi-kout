import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerApi } from './api.ts';
import { seedIfFresh } from './seed.ts';

const here = dirname(fileURLToPath(import.meta.url));

// En production le front est copie dans server/dist/public ; en developpement
// il est servi par Vite et ce repertoire n'existe pas.
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? resolve(here, 'public');

export async function buildApp(): Promise<FastifyInstance> {
  seedIfFresh();

  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // Derriere Caddy : necessaire pour que request.protocol vaille https et que
    // le cookie soit marque Secure.
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
  });

  await app.register(cookie);
  app.get('/healthz', async () => ({ ok: true }));
  await registerApi(app);

  if (existsSync(PUBLIC_DIR)) {
    await app.register(staticPlugin, {
      root: PUBLIC_DIR,
      index: false,
      setHeaders(res, path) {
        if (path.endsWith('sw.js') || path.endsWith('index.html') || path.endsWith('.webmanifest')) {
          res.setHeader('cache-control', 'no-cache');
        } else if (path.includes('/assets/')) {
          // Noms de fichiers hashes par Vite : immuables.
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        }
      },
    });

    // `index: false` fait repondre 403 sur la racine (c'est un repertoire) :
    // on sert le shell explicitement.
    app.get('/', (_request, reply) =>
      reply.header('cache-control', 'no-cache').sendFile('index.html', PUBLIC_DIR));

    // Repli SPA : toute route non-API rend le shell applicatif.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not-found' });
      return reply.header('cache-control', 'no-cache').sendFile('index.html', PUBLIC_DIR);
    });
  }

  return app;
}

export { PUBLIC_DIR };
