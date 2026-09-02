// Routage par fragment d'URL. Pas de bibliotheque : cinq ecrans, aucun parametre
// complexe, et le service worker sert le meme shell pour toutes les routes.

export type Route =
  | { name: 'home' }
  | { name: 'workout' }
  | { name: 'history' }
  | { name: 'session'; id: string }
  | { name: 'progress' }
  | { name: 'program' }
  | { name: 'settings' };

function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, tail] = path.split('/');

  switch (head) {
    case 'seance': return { name: 'workout' };
    case 'historique': return tail ? { name: 'session', id: tail } : { name: 'history' };
    case 'progression': return { name: 'progress' };
    case 'programme': return { name: 'program' };
    case 'reglages': return { name: 'settings' };
    default: return { name: 'home' };
  }
}

class Router {
  current = $state<Route>(parse(location.hash));

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('hashchange', () => { this.current = parse(location.hash); });
    }
  }

  go(path: string): void {
    location.hash = path.startsWith('#') ? path : `#/${path}`;
  }
}

export const router = new Router();

export const paths = {
  home: '#/',
  workout: '#/seance',
  history: '#/historique',
  session: (id: string) => `#/historique/${id}`,
  progress: '#/progression',
  program: '#/programme',
  settings: '#/reglages',
};
