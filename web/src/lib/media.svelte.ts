// Un seul point de rupture, a la largeur ou la barre d'onglets du bas cesse
// d'avoir du sens et devient une colonne laterale.
const WIDE = '(min-width: 860px)';

class Viewport {
  wide = $state(typeof window !== 'undefined' ? window.matchMedia(WIDE).matches : false);

  constructor() {
    if (typeof window === 'undefined') return;
    const query = window.matchMedia(WIDE);
    query.addEventListener('change', (event) => { this.wide = event.matches; });
  }
}

export const viewport = new Viewport();
