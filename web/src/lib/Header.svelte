<script lang="ts">
  import type { Snippet } from 'svelte';
  import SyncBadge from './SyncBadge.svelte';

  let { title, sub, actions }: { title: string; sub?: string; actions?: Snippet } = $props();
</script>

<header>
  <div class="grow stack">
    <h1 class="truncate">{title}</h1>
    {#if sub}<span class="label">{sub}</span>{/if}
  </div>
  <div class="row">
    <SyncBadge />
    {@render actions?.()}
  </div>
</header>

<style>
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    padding: calc(env(safe-area-inset-top, 0px) + 20px) var(--gutter) 16px;
    border-bottom: 1px solid var(--line);
  }
</style>
