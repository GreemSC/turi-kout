<script lang="ts">
  // Indicateur d'attente (section 3.5). Discret par construction : une pastille
  // et un nombre, jamais de modale, jamais de blocage. Il ne s'affiche que
  // lorsqu'il a quelque chose a dire.
  import { store } from './store.svelte.ts';
</script>

{#if store.pending > 0}
  <span class="badge" title="{store.pending} écriture(s) en attente d'envoi">
    <span class="dot" class:syncing={store.syncing}></span>
    <span class="num num-s">{store.pending}</span>
    <span class="unit">en attente</span>
  </span>
{:else if !store.online}
  <span class="badge">
    <span class="dot off"></span>
    <span class="unit">hors ligne</span>
  </span>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .dot.off { background: var(--ink-faint); }
  .dot.syncing { animation: pulse 1.1s ease-in-out infinite; }

  .num-s { color: var(--ink); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }
</style>
