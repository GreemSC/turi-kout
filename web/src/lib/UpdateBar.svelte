<script lang="ts">
  // Bandeau discret, jamais bloquant : la mise a jour attend qu'on la veuille.
  import { appUpdate } from './update.svelte.ts';
</script>

{#if appUpdate.available}
  <div class="bar" role="status">
    <span class="grow">Nouvelle version disponible.</span>
    <button class="btn btn-quiet" onclick={() => appUpdate.apply()}>Recharger</button>
    <button class="dismiss" onclick={() => (appUpdate.available = false)} aria-label="Plus tard">✕</button>
  </div>
{/if}

<style>
  .bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(var(--tap) + var(--bottom-safe));
    z-index: 30;

    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px var(--gutter);
    background: var(--surface-high);
    border-top: 1px solid var(--line-strong);
    font-size: 0.875rem;
  }

  .btn { min-height: 38px; padding: 0 14px; font-size: 0.8125rem; }

  .dismiss {
    width: 38px;
    height: 38px;
    color: var(--ink-faint);
    flex: none;
  }

  @media (min-width: 860px) {
    .bar {
      left: var(--rail);
      bottom: 0;
    }
  }
</style>
