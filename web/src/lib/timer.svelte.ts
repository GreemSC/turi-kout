// Minuteur de repos (section 5.5).
//
// Le decompte s'appuie sur une echeance absolue, jamais sur un compteur
// decremente : un onglet en arriere-plan voit ses timers brides, mais l'horloge,
// elle, ne ment pas. La sonnerie est doublee sur trois canaux, parce qu'aucun
// n'est fiable seul quand l'ecran est eteint :
//   1. Web Audio, avec un oscillateur programme a l'echeance exacte. Le contexte
//      reste actif tant qu'un son y circule, meme onglet masque.
//   2. Le service worker, qui affiche une notification vibrante. Il survit au
//      gel de la page.
//   3. navigator.vibrate, quand la page est encore au premier plan.

class RestTimer {
  /** Echeance absolue en millisecondes, null quand le minuteur est a l'arret. */
  endsAt = $state<number | null>(null);
  /** Duree totale du repos en cours, pour la jauge. */
  total = $state(0);
  now = $state(Date.now());
  /** Nom de l'exercice suivant, repris dans la notification. */
  label = $state('');

  private ticker: number | null = null;
  private audio: AudioContext | null = null;
  private scheduled: { osc: OscillatorNode; keepalive: OscillatorNode; gain: GainNode }[] = [];
  private wakeLock: WakeLockSentinel | null = null;

  get remaining(): number {
    return this.endsAt === null ? 0 : Math.max(0, (this.endsAt - this.now) / 1000);
  }

  get running(): boolean {
    return this.endsAt !== null && this.remaining > 0;
  }

  /** Fraction ecoulee, de 0 a 1. */
  get progress(): number {
    if (!this.total || this.endsAt === null) return 0;
    return Math.min(1, Math.max(0, 1 - this.remaining / this.total));
  }

  /** Demarre ou redemarre un repos. Appele a la validation d'une serie. */
  start(seconds: number, label = ''): void {
    this.cancel(false);
    this.total = seconds;
    this.label = label;
    this.endsAt = Date.now() + seconds * 1000;
    this.now = Date.now();

    this.tick();
    this.scheduleBeep(seconds);
    this.notifyServiceWorker();
  }

  adjust(deltaSeconds: number): void {
    if (this.endsAt === null) return;
    const next = Math.max(0, (this.endsAt - Date.now()) / 1000 + deltaSeconds);
    if (next <= 0) return this.cancel();
    this.total = Math.max(this.total, next);
    this.endsAt = Date.now() + next * 1000;
    this.stopBeeps();
    this.scheduleBeep(next);
    this.notifyServiceWorker();
  }

  cancel(clearNotification = true): void {
    this.endsAt = null;
    this.total = 0;
    this.stopBeeps();
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (clearNotification) {
      navigator.serviceWorker?.controller?.postMessage({ type: 'rest:cancel' });
    }
  }

  private tick(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = window.setInterval(() => {
      this.now = Date.now();
      if (this.endsAt !== null && this.now >= this.endsAt) {
        if (document.visibilityState === 'visible') navigator.vibrate?.([200, 100, 200, 100, 400]);
        clearInterval(this.ticker!);
        this.ticker = null;
      }
    }, 250);
  }

  // --- Canal 1 : Web Audio ---------------------------------------------------

  /**
   * Doit etre appele depuis un geste utilisateur (la validation d'une serie en
   * est un) pour que le contexte audio soit autorise a demarrer.
   */
  private context(): AudioContext | null {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.audio ??= new Ctor();
      if (this.audio.state === 'suspended') void this.audio.resume();
      return this.audio;
    } catch {
      return null;
    }
  }

  private scheduleBeep(seconds: number): void {
    const ctx = this.context();
    if (!ctx) return;

    const at = ctx.currentTime + seconds;

    // Bourdon inaudible : empeche le contexte d'etre suspendu pendant l'attente,
    // ce qui annulerait l'oscillateur programme.
    const keepalive = ctx.createOscillator();
    const quiet = ctx.createGain();
    keepalive.frequency.value = 40;
    quiet.gain.value = 0.0001;
    keepalive.connect(quiet).connect(ctx.destination);
    keepalive.start();
    keepalive.stop(at + 2);

    // Trois breves impulsions montantes : audible sans etre agressif.
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, at);

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, at);
    osc.connect(gain);

    for (let i = 0; i < 3; i++) {
      const from = at + i * 0.22;
      gain.gain.setValueAtTime(0.0001, from);
      gain.gain.exponentialRampToValueAtTime(0.28, from + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, from + 0.16);
    }
    osc.start(at);
    osc.stop(at + 0.75);

    this.scheduled.push({ osc, keepalive, gain });
  }

  private stopBeeps(): void {
    for (const node of this.scheduled) {
      try { node.osc.stop(); node.keepalive.stop(); } catch { /* deja arrete */ }
      node.gain.disconnect();
    }
    this.scheduled = [];
  }

  // --- Canal 2 : service worker ----------------------------------------------

  private notifyServiceWorker(): void {
    if (this.endsAt === null) return;
    navigator.serviceWorker?.ready
      .then((registration) => {
        registration.active?.postMessage({
          type: 'rest:start',
          endsAt: this.endsAt,
          label: this.label ? `Série suivante : ${this.label}` : 'Série suivante.',
        });
      })
      .catch(() => undefined);
  }

  // --- Ecran allume pendant la seance ----------------------------------------

  /**
   * Maintient l'ecran allume tant que la seance est ouverte : c'est le moyen le
   * plus sur d'entendre le minuteur, et cela evite de deverrouiller le telephone
   * entre chaque serie.
   */
  async holdScreen(): Promise<void> {
    try {
      this.wakeLock ??= await navigator.wakeLock?.request('screen');
      this.wakeLock?.addEventListener('release', () => { this.wakeLock = null; });
    } catch {
      // Verrou refuse (batterie faible, onglet masque) : sans consequence.
    }
  }

  releaseScreen(): void {
    void this.wakeLock?.release();
    this.wakeLock = null;
  }

  /** Redemande le verrou au retour au premier plan : il est perdu a chaque masquage. */
  reacquireScreen(): void {
    if (document.visibilityState === 'visible') void this.holdScreen();
  }
}

export const restTimer = new RestTimer();

/** Demande l'autorisation de notifier, depuis un geste utilisateur. */
export async function ensureNotifications(): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  try { await Notification.requestPermission(); } catch { /* refus : les autres canaux restent */ }
}
