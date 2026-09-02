<script lang="ts">
  // Bandeau ancre en bas, visible en permanence pendant la seance (section 5.5).
  // Au repos il rappelle la duree prevue ; en marche il devient un decompte.
  import { restTimer } from './timer.svelte.ts';
  import { clock } from './format.ts';

  let { restSeconds }: { restSeconds: number } = $props();

  const running = $derived(restTimer.running);
  const done = $derived(restTimer.endsAt !== null && !running);
</script>

<div class="timer" class:running class:done>
  <div class="fill" style:width="{running ? restTimer.progress * 100 : done ? 100 : 0}%"></div>

  <div class="content">
    {#if running}
      <span class="num num-m">{clock(restTimer.remaining)}</span>
      <span class="unit grow">repos</span>
      <button class="step" onclick={() => restTimer.adjust(-15)} aria-label="Retirer 15 secondes">−15 s</button>
      <button class="step" onclick={() => restTimer.adjust(15)} aria-label="Ajouter 15 secondes">+15 s</button>
    {:else if done}
      <span class="num num-m accent">0:00</span>
      <span class="unit grow">repos terminé</span>
      <button class="step" onclick={() => restTimer.cancel()}>Effacer</button>
    {:else}
      <span class="num num-m faint">{clock(restSeconds)}</span>
      <span class="unit grow">repos prévu</span>
    {/if}
  </div>
</div>

<style>
  .timer {
    position: relative;
    height: 46px;
    background: var(--surface);
    border-top: 1px solid var(--line);
    overflow: hidden;
  }

  /* Le remplissage est la seule animation de l'application (section 8) : il est
     pilote par le tick du minuteur, pas par une transition CSS, pour rester
     exact meme apres un passage en arriere-plan. */
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--surface-high);
  }
  .running .fill { background: color-mix(in srgb, var(--accent) 22%, var(--surface)); }
  .done .fill { background: color-mix(in srgb, var(--accent) 40%, var(--surface)); }

  .content {
    position: relative;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px 0 var(--gutter);
  }

  .step {
    min-width: 56px;
    height: 38px;
    border: 1px solid var(--line-strong);
    border-radius: 2px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
</style>
