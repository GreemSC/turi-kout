import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { DB_PATH } from './db.ts';

export const COOKIE_NAME = 'tk_auth';
/** Dix ans : se faire dejecter en pleine seance est inacceptable (section 2). */
export const COOKIE_MAX_AGE = 10 * 365 * 24 * 3600;

/**
 * Le jeton vient de AUTH_TOKEN. S'il n'est pas defini — premier `docker compose
 * up` sur une machine vierge — on en tire un au hasard et on le conserve a cote
 * de la base, puis on l'affiche dans les journaux. Mieux vaut un secret genere
 * qu'un mot de passe par defaut embarque dans l'image.
 */
function resolveToken(): string {
  const fromEnv = process.env.AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const file = join(dirname(DB_PATH), '.auth-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();

  const generated = randomBytes(18).toString('base64url');
  writeFileSync(file, generated, { mode: 0o600 });
  console.warn(
    `\n  AUTH_TOKEN n'est pas defini. Jeton genere pour cette installation :\n\n      ${generated}\n\n` +
    `  Il est conserve dans ${file}. Definissez AUTH_TOKEN pour le remplacer.\n`,
  );
  return generated;
}

const EXPECTED = Buffer.from(resolveToken(), 'utf8');

export function tokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const given = Buffer.from(candidate, 'utf8');
  // timingSafeEqual exige des longueurs egales ; la longueur n'est pas un
  // secret exploitable ici.
  if (given.length !== EXPECTED.length) return false;
  return timingSafeEqual(given, EXPECTED);
}

export function cookieOptions(request: FastifyRequest) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    secure: request.protocol === 'https',
  };
}

/** Hook onRequest : refuse toute requete /api sans cookie valide. */
export function requireAuth(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (tokenMatches(request.cookies[COOKIE_NAME])) return done();
  reply.code(401).send({ error: 'unauthorized' });
}
