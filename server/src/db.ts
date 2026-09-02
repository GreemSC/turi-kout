import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.DB_PATH ?? './data/turi-kout.sqlite';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// Le tout premier PRAGMA est aussi la premiere ecriture : c'est lui qui revele
// une base ou un repertoire non inscriptible, avant meme la migration.
try {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
} catch (err) {
  throw explain(err);
}

/**
 * Echelle de migrations, indexee par version cible : `MIGRATIONS[0]` amene la
 * base de la version 0 a la version 1. Chaque marche s'applique dans sa propre
 * transaction, et `user_version` n'avance qu'une fois la marche passee — une
 * migration interrompue laisse donc la base dans son etat d'avant.
 *
 * Les fichiers SQL sont copies a cote du bundle par le build ; en developpement
 * ils sont dans src/.
 */
const MIGRATIONS: string[] = [
  'schema.sql',                 // v1 : le schema litteral de la specification
  'migrations/002-training.sql', // v2 : mesure de l'entrainement
  'migrations/003-loads.sql',    // v3 : charges justes, notes par exercice
  'migrations/004-auto-warmup.sql',  // v4 : echauffement guide par defaut
  'migrations/005-alternatives.sql', // v5 : alternatives et schemas
];

function migrate(): { fresh: boolean } {
  const from = db.pragma('user_version', { simple: true }) as number;
  const fresh = from === 0;

  for (let version = from; version < MIGRATIONS.length; version++) {
    const sql = readFileSync(join(here, MIGRATIONS[version]), 'utf8');
    try {
      db.transaction(() => {
        db.exec(sql);
        // Le pragma n'accepte pas de parametre lie.
        db.pragma(`user_version = ${version + 1}`);
      })();
    } catch (err) {
      throw explain(err, version + 1);
    }
  }

  return { fresh };
}

/**
 * Un demarrage qui echoue laisse la base intacte, mais un operateur merite mieux
 * qu'une trace de pile. Le cas le plus frequent est une sauvegarde restauree
 * avec le mauvais proprietaire : le fichier existe, il est lisible, et rien ne
 * peut y etre ecrit — ni la base, ni le journal WAL qui l'accompagne.
 */
function explain(err: unknown, version?: number): Error {
  const code = (err as { code?: string }).code ?? '';
  const detail = err instanceof Error ? err.message : String(err);

  if (code.startsWith('SQLITE_READONLY') || code.startsWith('SQLITE_CANTOPEN')) {
    return new Error(
      `La base ${DB_PATH} n'est pas accessible en ecriture.\n` +
      "  Verifiez le proprietaire et les droits du fichier ainsi que de son repertoire\n" +
      "  — le fichier .sqlite, mais aussi les .sqlite-wal et .sqlite-shm qui l'accompagnent.\n" +
      `  Dans le conteneur : chown -R node:node ${dirname(DB_PATH)}\n` +
      `  (detail : ${detail})`,
    );
  }
  return new Error(version === undefined
    ? `Ouverture de ${DB_PATH} impossible : ${detail}`
    : `Migration vers la version ${version} interrompue : ${detail}\n` +
      '  La base est restee dans son etat precedent.');
}

const state = migrate();

/** true si la base venait d'etre creee : c'est le signal pour jouer le seed complet. */
export const isFreshDatabase = state.fresh;
