<script lang="ts">
  // Schema du mouvement. Le corps en gris, la charge en couleur d'accent, le
  // materiel fixe en filet : la couleur porte l'information, elle ne decore pas.
  import { diagram, type Shape } from './diagrams.ts';

  let { key, label, height = 88 }: { key: string | null; label: string; height?: number } = $props();

  const shapes = $derived(diagram(key));

  const stroke = (shape: Shape) =>
    shape.t === 'load' ? 'var(--accent)' : shape.t === 'frame' ? 'var(--line-strong)' : 'var(--ink-dim)';
</script>

{#if shapes.length}
  <svg class="diagram" viewBox="0 0 120 68" style:height="{height}px" role="img" aria-label="Schéma : {label}">
    {#each shapes as shape, i (i)}
      {#if shape.k === 'l'}
        <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={stroke(shape)} stroke-width={shape.w ?? 2} />
      {:else if shape.k === 'c'}
        <circle cx={shape.cx} cy={shape.cy} r={shape.r} stroke={stroke(shape)} fill={shape.fill ? stroke(shape) : 'none'} stroke-width="2" />
      {:else}
        <path d={shape.d} stroke={stroke(shape)} fill="none" stroke-width="2" />
      {/if}
    {/each}
  </svg>
{/if}

<style>
  .diagram {
    display: block;
    width: 100%;
    max-width: 260px;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
