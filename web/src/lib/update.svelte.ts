// Le service worker prend la main des qu'une nouvelle version est installee,
// mais la page continue de faire tourner l'ancien code jusqu'au rechargement.
// Sans signal, on croit que le deploiement n'a pas pris.

class AppUpdate {
  available = $state(false);

  /**
   * `controllerchange` se declenche aussi a la toute premiere installation,
   * quand il n'y avait encore aucun controleur : on ne signale que le
   * remplacement d'une version par une autre.
   */
  watch(): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) this.available = true;
    });
  }

  apply(): void {
    location.reload();
  }
}

export const appUpdate = new AppUpdate();
