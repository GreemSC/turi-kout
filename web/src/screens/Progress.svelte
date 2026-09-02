<script lang="ts">
  import { store } from '../lib/store.svelte.ts';
  import {
    bestE1rm, bodyweightSeries, previousPerformance, topSet, volumeLabel,
    volumeStatus, weeklyTrend, weeklyVolume, workVolume,
  } from '../../../shared/domain.ts';
  import { ago, kg } from '../lib/format.ts';
  import { viewport } from '../lib/media.svelte.ts';
  import Header from '../lib/Header.svelte';
  import Chart from '../lib/Chart.svelte';

  let days = $state(90);

  // --- Volume hebdomadaire par muscle ---------------------------------------
  // Calcule sur les donnees locales : l'ecran reste juste hors ligne.

  const WEEKS = 8;
  const volume = $derived(weeklyVolume($state.snapshot(store.sets), $state.snapshot(store.exerciseMuscles), WEEKS));

  let weekBack = $state(0);
  const week = $derived(volume[volume.length - 1 - weekBack]);

  /** Muscles travailles cette semaine-la, du plus sollicite au moins. */
  const trainedMuscles = $derived.by(() => {
    if (!week) return [];
    return store.muscles
      .map((muscle) => ({
        muscle,
        sets: week.byMuscle[muscle.id] ?? 0,
        // Les huit semaines sont deja calculees : la tendance ne coute rien.
        history: volume.map((w) => w.byMuscle[muscle.id] ?? 0),
      }))
      .filter((row) => row.sets > 0)
      .sort((a, b) => b.sets - a.sets);
  });

  /**
   * Micro-courbe des huit dernieres semaines. Un volume qui grimpe semaine
   * apres semaine est le signal de fatigue le plus fiable, et il ne se voit pas
   * sur la seule semaine en cours.
   */
  function sparkline(values: number[], width = 62, height = 16): string {
    const max = Math.max(1, ...values);
    return values
      .map((v, i) => `${(i / Math.max(1, values.length - 1)) * width},${height - (v / max) * height}`)
      .join(' ');
  }

  /** Muscles du programme restes a zero : c'est l'information la plus utile. */
  const untrained = $derived.by(() => {
    if (!week) return [];
    const planned = new Set(store.exerciseMuscles.map((m) => m.muscle_id));
    return store.muscles.filter((m) => planned.has(m.id) && !(week.byMuscle[m.id] > 0));
  });

  /** Position d'une valeur sur l'echelle du muscle, en pourcentage. */
  const scale = (value: number, mrv: number) => Math.min(100, (value / (mrv * 1.15)) * 100);

  // --- Force par exercice ---------------------------------------------------

  const trained = $derived.by(() => {
    const ids = new Set(store.sets.filter((s) => s.kind !== 'warmup').map((s) => s.exercise_id));
    return store.exercises.filter((e) => ids.has(e.id));
  });

  let exerciseId = $state<number | null>(null);
  const selected = $derived(exerciseId ?? trained[0]?.id ?? null);

  // Le `select` est lie a `exerciseId` : sans valeur initiale il s'afficherait
  // vide alors qu'une courbe est deja tracee.
  $effect(() => {
    if (exerciseId === null && trained.length > 0) exerciseId = trained[0].id;
  });

  /**
   * Une valeur par seance. Le 1RM estime porte la courbe : le tonnage monte des
   * qu'on ajoute une serie et descend des qu'on monte lourd sur moins de
   * repetitions, il ne dit donc rien de la force.
   */
  const sessions = $derived.by(() => {
    if (selected === null) return [];
    const bySession = new Map<string, typeof store.sets>();
    for (const entry of store.sets) {
      if (entry.exercise_id !== selected || entry.kind === 'warmup') continue;
      const bucket = bySession.get(entry.session_id);
      if (bucket) bucket.push(entry);
      else bySession.set(entry.session_id, [entry]);
    }
    return [...bySession.entries()]
      .map(([sessionId, entries]) => ({
        date: store.sessions.find((s) => s.id === sessionId)?.started_at ?? entries[0].done_at,
        e1rm: bestE1rm(entries, store.resolveLoad),
        volume: workVolume(entries, store.resolveLoad),
        top: topSet(entries, store.resolveLoad),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  });

  const latest = $derived(sessions[sessions.length - 1]);
  const last = $derived(selected === null ? null : previousPerformance(store.sets, store.sessions, selected));

  // --- Poids corporel -------------------------------------------------------

  const weightSeries = $derived.by(() => {
    const full = bodyweightSeries($state.snapshot(store.bodyweights), days);
    // Sans cette coupe, une fenetre de 90 jours avec trois semaines de pesees
    // tasse toute la courbe dans le dernier quart du graphique.
    const first = full.findIndex((p) => p.raw !== null);
    return first <= 0 ? full : full.slice(first);
  });
  const trend = $derived(weeklyTrend(weightSeries, store.settings.weekly_gain_target_kg));

  const weightChart = $derived([
    { values: weightSeries.map((p) => p.raw), kind: 'dots' as const, emphasis: 'muted' as const },
    { values: weightSeries.map((p) => p.avg), kind: 'line' as const, emphasis: 'primary' as const, connect: true },
  ]);

  const latestAvg = $derived([...weightSeries].reverse().find((p) => p.avg !== null)?.avg ?? null);
</script>

<Header title="Progression" />

<div class="screen cols">
  <!--
    Volume hebdomadaire en sets fractionnes : une serie vaut 1,0 pour le muscle
    moteur et 0,5 pour chaque synergiste. C'est le comptage qui predit le mieux
    l'hypertrophie, devant le comptage direct qui ignore les synergistes.
  -->
  <section class="band">
    <div class="eyebrow">
      <span class="label">Volume par muscle</span>
      <div class="range" role="group" aria-label="Semaine">
        <button class:on={weekBack === 0} onclick={() => (weekBack = 0)}>cette semaine</button>
        <button class:on={weekBack === 1} onclick={() => (weekBack = 1)}>la précédente</button>
      </div>
    </div>

    {#if trainedMuscles.length === 0}
      <p class="label">Aucune série de travail cette semaine.</p>
    {:else}
      <div class="figures">
        <div class="stack">
          <span class="num num-l">{week.workingSets}</span>
          <span class="unit">série{week.workingSets > 1 ? 's' : ''} de travail</span>
        </div>
        <div class="stack">
          <span class="num num-l">{trainedMuscles.length}</span>
          <span class="unit">muscle{trainedMuscles.length > 1 ? 's' : ''} sollicité{trainedMuscles.length > 1 ? 's' : ''}</span>
        </div>
      </div>

      <ul class="muscles">
        {#each trainedMuscles as row (row.muscle.id)}
          {@const status = volumeStatus(row.sets, row.muscle)}
          <li>
            <div class="row spread head">
              <span class="name grow">{row.muscle.name}</span>
              <svg class="spark" width="62" height="16" viewBox="0 0 62 16" aria-hidden="true">
                <polyline points={sparkline(row.history)} />
              </svg>
              <span class="num num-s">{row.sets.toString().replace('.', ',')}</span>
            </div>

            <!-- L'echelle porte les trois reperes : minimum, zone la plus
                 productive, plafond recuperable. -->
            <div class="gauge">
              <span
                class="band-mav"
                style:left="{scale(row.muscle.mav_low, row.muscle.mrv)}%"
                style:width="{scale(row.muscle.mav_high, row.muscle.mrv) - scale(row.muscle.mav_low, row.muscle.mrv)}%"
              ></span>
              <span class="tick" style:left="{scale(row.muscle.mev, row.muscle.mrv)}%"></span>
              <span class="tick mrv" style:left="{scale(row.muscle.mrv, row.muscle.mrv)}%"></span>
              <span class="fill {status}" style:width="{scale(row.sets, row.muscle.mrv)}%"></span>
            </div>

            <span class="label">{volumeLabel(row.sets, row.muscle)}</span>
          </li>
        {/each}
      </ul>

      {#if untrained.length}
        <p class="label untrained">
          Pas touché cette semaine : {untrained.map((m) => m.name.toLowerCase()).join(', ')}.
        </p>
      {/if}
    {/if}
  </section>

  <section class="band">
    <div class="eyebrow">
      <span class="label">Force par exercice</span>
      <span class="label">{sessions.length} séance{sessions.length > 1 ? 's' : ''}</span>
    </div>

    {#if trained.length === 0}
      <p class="label">Aucun exercice travaillé pour l'instant.</p>
    {:else}
      <select class="field select" bind:value={exerciseId} aria-label="Exercice">
        {#each trained as exercise (exercise.id)}
          <option value={exercise.id}>{exercise.name}</option>
        {/each}
      </select>

      <div class="figures">
        <div class="stack">
          <span class="num num-l">{latest?.e1rm === null || latest?.e1rm === undefined ? '—' : kg(latest.e1rm)}</span>
          <span class="unit">1RM estimé</span>
        </div>
        <div class="stack">
          <span class="num num-l">{kg(latest?.top ?? 0)}</span>
          <span class="unit">série la plus lourde</span>
        </div>
        <div class="stack">
          <span class="num num-l">{Math.round(latest?.volume ?? 0).toLocaleString('fr-FR')}</span>
          <span class="unit">kg soulevés</span>
        </div>
      </div>

      <!--
        Le 1RM estime porte seul la courbe. Y superposer le tonnage melangerait
        deux grandeurs sans commune mesure — quelques dizaines de kilos contre
        quelques centaines — et ecraserait celle qui compte.
      -->
      <Chart
        series={[{ values: sessions.map((s) => s.e1rm), kind: 'line', emphasis: 'primary', connect: true }]}
        height={viewport.wide ? 220 : 148}
        format={(n) => kg(Math.round(n * 10) / 10)}
        caption="1RM estimé par séance"
      />
      <p class="label legend">
        <span class="swatch"></span> 1RM estimé, en kilos
        {#if store.exercise(selected ?? 0)?.bodyweight_factor}
          <span class="unit">— poids du corps compris</span>
        {/if}
      </p>

      {#if last}
        <div class="recap">
          <span class="label">Dernière séance · {ago(last.date)}</span>
          <div class="sets">
            {#each last.sets as entry (entry.id)}
              <span class="num num-s">{kg(entry.weight_kg)}<span class="unit">×</span>{entry.reps}</span>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </section>

  <section class="band">
    <div class="eyebrow">
      <span class="label">Poids corporel</span>
      <div class="range" role="group" aria-label="Période">
        {#each [30, 90, 365] as option (option)}
          <button class:on={days === option} onclick={() => (days = option)}>{option} j</button>
        {/each}
      </div>
    </div>

    <div class="figures">
      <div class="stack">
        <span class="num num-l">{latestAvg === null ? '—' : kg(Math.round(latestAvg * 10) / 10)}</span>
        <span class="unit">moyenne sur 7 jours</span>
      </div>
      <div class="stack">
        <span class="num num-s trendline" class:accent={trend.status === 'on-target'}>{trend.label}</span>
        <span class="unit">cible {kg(store.settings.weekly_gain_target_kg)} kg/semaine</span>
      </div>
    </div>

    <Chart
      series={weightChart}
      height={viewport.wide ? 220 : 148}
      format={(n) => kg(Math.round(n * 10) / 10)}
      caption="Poids corporel : mesures brutes et moyenne glissante sur 7 jours"
    />
    <p class="label legend">
      <span class="swatch muted dot"></span> mesures du jour
      <span class="swatch"></span> moyenne sur 7 jours
    </p>
  </section>
</div>

<style>
  .select { margin-bottom: 16px; }

  .figures {
    display: flex;
    gap: 24px;
    margin-bottom: 18px;
    flex-wrap: wrap;
  }

  .trendline { font-size: 0.9375rem; letter-spacing: 0; font-weight: 550; }

  .range { display: flex; gap: 4px; }
  .range button {
    min-width: 44px;
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 0.6875rem;
    color: var(--ink-faint);
  }
  .range button.on { color: var(--ink); border-color: var(--line-strong); }

  /* --- Jauge de volume --- */

  .muscles { list-style: none; margin: 0; padding: 0; }
  .muscles li { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .muscles li:last-child { border-bottom: 0; }

  .head { margin-bottom: 5px; gap: 12px; }
  .name { font-size: 0.9375rem; font-weight: 550; }

  /* Huit semaines de volume, en fond : la tendance compte autant que le total. */
  .spark { flex: none; overflow: visible; }
  .spark polyline {
    fill: none;
    stroke: var(--line-strong);
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .gauge {
    position: relative;
    height: 6px;
    background: var(--surface-high);
    margin-bottom: 5px;
  }

  /* La zone la plus productive, en fond. */
  .band-mav {
    position: absolute;
    top: 0; bottom: 0;
    background: var(--line-strong);
  }

  .tick {
    position: absolute;
    top: -2px; bottom: -2px;
    width: 1px;
    background: var(--ink-faint);
  }
  .tick.mrv { background: var(--red); }

  .fill {
    position: absolute;
    top: 0; bottom: 0; left: 0;
    background: var(--ink-dim);
  }
  .fill.optimal { background: var(--accent); }
  .fill.au-dessus-mrv { background: var(--red); }

  .untrained { margin-top: 12px; }

  .recap { margin-top: 16px; }
  .sets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin-top: 6px;
  }
  .sets .unit { margin: 0 2px; }

  .legend {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
  }
  .swatch {
    width: 10px;
    height: 3px;
    background: var(--accent);
    display: inline-block;
  }
  .swatch.muted { background: var(--line-strong); }
  .swatch.dot { background: var(--ink-faint); border-radius: 50%; height: 5px; width: 5px; }

  /* Bureau : les trois suivis cote a cote, et des graphiques plus hauts —
     c'est l'usage principal de l'ordinateur (section 1). */
  @media (min-width: 860px) {
    .figures { gap: 32px; }
  }
</style>
