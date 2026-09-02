<script lang="ts">
  // Trace en SVG, sans bibliotheque de graphiques : deux courbes suffisent et
  // le budget est de 150 ko compresses. Les coordonnees sont calculees en
  // pixels a partir de la largeur reelle du conteneur, pour qu'un point reste
  // rond et qu'un trait garde son epaisseur quelle que soit la taille d'ecran.

  interface Series {
    values: (number | null)[];
    kind: 'line' | 'dots';
    /** `muted` passe en fond, `primary` au premier plan. */
    emphasis: 'primary' | 'muted';
    /**
     * Relie les points par-dessus les trous. Une moyenne glissante est une
     * grandeur continue echantillonnee irregulierement : la couper a chaque
     * jour sans pesee la rendrait invisible. Une mesure brute, elle, a de
     * vraies interruptions et doit les montrer.
     */
    connect?: boolean;
  }

  let {
    series,
    height = 148,
    format = (n: number) => String(Math.round(n)),
    caption,
  }: { series: Series[]; height?: number; format?: (n: number) => string; caption?: string } = $props();

  let width = $state(320);
  const pad = { top: 10, right: 46, bottom: 10, left: 6 };

  const count = $derived(Math.max(...series.map((s) => s.values.length), 0));

  const bounds = $derived.by(() => {
    const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    if (all.length === 0) return { min: 0, max: 1 };
    const min = Math.min(...all);
    const max = Math.max(...all);
    if (min === max) return { min: min - 1, max: max + 1 };
    const margin = (max - min) * 0.12;
    return { min: min - margin, max: max + margin };
  });

  const plotW = $derived(Math.max(1, width - pad.left - pad.right));
  const plotH = $derived(height - pad.top - pad.bottom);

  const x = (i: number) => pad.left + (count <= 1 ? plotW / 2 : (i / (count - 1)) * plotW);
  const y = (value: number) => pad.top + plotH - ((value - bounds.min) / (bounds.max - bounds.min)) * plotH;

  /** Chemin en segments. Sans `connect`, un trou de donnees coupe la ligne. */
  function path(values: (number | null)[], connect = false): string {
    const commands: string[] = [];
    let open = false;
    values.forEach((value, i) => {
      if (value === null) {
        if (!connect) open = false;
        return;
      }
      commands.push(`${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(value).toFixed(1)}`);
      open = true;
    });
    // Un point isole ne produirait qu'un `M`, invisible. Le doubler donne un
    // segment de longueur nulle, rendu comme un point par `stroke-linecap`.
    if (commands.length === 1) commands.push(commands[0].replace('M', 'L'));
    return commands.join(' ');
  }

  const hasData = $derived(series.some((s) => s.values.some((v) => v !== null)));
</script>

<div class="chart" bind:clientWidth={width}>
  {#if hasData}
    <svg {width} {height} role="img" aria-label={caption ?? 'Graphique'}>
      <!-- Trois reperes horizontaux : bas, milieu, haut. Assez pour situer une
           valeur, pas assez pour encombrer. -->
      {#each [0, 0.5, 1] as ratio (ratio)}
        {@const value = bounds.min + (bounds.max - bounds.min) * ratio}
        <line x1={pad.left} x2={pad.left + plotW} y1={y(value)} y2={y(value)} class="grid" />
        <text x={pad.left + plotW + 6} y={y(value) + 4} class="tick">{format(value)}</text>
      {/each}

      {#each series as s, i (i)}
        {#if s.kind === 'line'}
          <path d={path(s.values, s.connect)} class="line" class:muted={s.emphasis === 'muted'} />
        {:else}
          {#each s.values as value, index (index)}
            {#if value !== null}
              <circle cx={x(index)} cy={y(value)} r={s.emphasis === 'primary' ? 3 : 2.2} class="dot" class:muted={s.emphasis === 'muted'} />
            {/if}
          {/each}
        {/if}
      {/each}
    </svg>
  {:else}
    <p class="label nodata" style:height="{height}px">Pas encore de données à tracer.</p>
  {/if}
</div>

<style>
  .chart { width: 100%; }
  svg { display: block; overflow: visible; }

  .grid { stroke: var(--line); stroke-width: 1; }
  .tick {
    fill: var(--ink-faint);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .line.muted { stroke: var(--line-strong); stroke-width: 1.5; }

  .dot { fill: var(--accent); }
  .dot.muted { fill: var(--ink-faint); }

  .nodata { display: flex; align-items: center; }
</style>
