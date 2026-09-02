// Rassemble le livrable du serveur : le bundle, le schema SQL qu'il lit au
// demarrage, et le front deja construit par Vite.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

mkdirSync(dist, { recursive: true });
cpSync(resolve(root, 'src/schema.sql'), resolve(dist, 'schema.sql'));
cpSync(resolve(root, 'src/migrations'), resolve(dist, 'migrations'), { recursive: true });

const web = resolve(root, '../web/dist');
if (existsSync(web)) {
  // Vider d'abord : les noms de fichiers sont hashes, sans nettoyage le
  // livrable accumule un bundle par construction.
  rmSync(resolve(dist, 'public'), { recursive: true, force: true });
  cpSync(web, resolve(dist, 'public'), { recursive: true });
} else {
  console.warn('Front absent : lancez `npm run build --workspace=web` avant.');
}
console.log('Livrable serveur pret dans server/dist.');
