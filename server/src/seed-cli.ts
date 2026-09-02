// Point d'entree de `npm run seed`. Le garder separe de seed.ts : une garde
// « suis-je le module principal ? » devient toujours vraie une fois le serveur
// bundle par esbuild, et le seed se jouerait deux fois au demarrage.
import { db } from './db.ts';
import { seedIfFresh } from './seed.ts';

seedIfFresh();

const count = db.prepare('SELECT COUNT(*) n FROM routine_exercise').get() as { n: number };
console.log(`Base prete : ${count.n} lignes de programme.`);
