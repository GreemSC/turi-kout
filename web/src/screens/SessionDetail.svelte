<script lang="ts">
  // Section 6 : les seances passees sont modifiables. Une erreur de saisie en
  // salle arrive tout le temps, la correction doit etre directe — on edite la
  // valeur sur place, sans mode edition ni boite de dialogue.
  import { store } from '../lib/store.svelte.ts';
  import { router, paths } from '../lib/router.svelte.ts';
  import { workingSets, workVolume } from '../../../shared/domain.ts';
  import { dayLabelLong, duration, kg, timeLabel } from '../lib/format.ts';
  import Header from '../lib/Header.svelte';

  let { id }: { id: string } = $props();

  const session = $derived(store.sessions.find((s) => s.id === id));
  const sets = $derived(session ? store.setsOf(session.id) : []);

  /** Regroupe par exercice, dans l'ordre ou ils ont ete travailles. */
  const groups = $derived.by(() => {
    const order: number[] = [];
    const byExercise = new Map<number, typeof sets>();
    for (const entry of [...sets].sort((a, b) => a.done_at.localeCompare(b.done_at))) {
      if (!byExercise.has(entry.exercise_id)) {
        byExercise.set(entry.exercise_id, []);
        order.push(entry.exercise_id);
      }
      byExercise.get(entry.exercise_id)!.push(entry);
    }
    return order.map((exerciseId) => ({
      exercise: store.exercise(exerciseId),
      entries: byExercise.get(exerciseId)!.sort((a, b) => a.set_index - b.set_index),
    }));
  });

  let note = $state('');
  $effect(() => { note = session?.note ?? ''; });

  function commitWeight(setId: string, value: string) {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) store.editSet(setId, { weight_kg: Math.round(parsed * 4) / 4 });
  }

  function commitReps(setId: string, value: string) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) store.editSet(setId, { reps: parsed });
  }

  /** Une serie marquee du mauvais type fausse le volume : elle doit se corriger ici. */
  function toggleKind(setId: string, current: string) {
    store.editSet(setId, { kind: current === 'warmup' ? 'work' : 'warmup' });
  }
</script>

{#if session}
  <Header title={store.routineDay(session.routine_day_id)?.name ?? 'Séance'} sub={dayLabelLong(session.started_at)}>
    {#snippet actions()}
      <button class="btn btn-quiet small" onclick={() => router.go(paths.history)}>Retour</button>
    {/snippet}
  </Header>

  <div class="screen">
    <section class="band row spread">
      <div class="stack">
        <span class="num num-m">{timeLabel(session.started_at)}{session.ended_at ? ` — ${timeLabel(session.ended_at)}` : ''}</span>
        <span class="unit">{session.ended_at ? duration(session.started_at, session.ended_at) : 'séance ouverte'}</span>
      </div>
      <div class="stack" style="align-items:flex-end">
        <span class="num num-m">{Math.round(workVolume(sets, store.resolveLoad)).toLocaleString('fr-FR')}</span>
        <span class="unit">kg soulevés</span>
      </div>
    </section>

    {#each groups as group (group.exercise?.id ?? Math.random())}
      <section class="band">
        <div class="eyebrow">
          <span class="label">{group.exercise?.name ?? 'Exercice supprimé'}</span>
          <span class="label">{workingSets(group.entries).length} séries de travail</span>
        </div>
        {#each group.entries as entry (entry.id)}
          <div class="line" class:warm={entry.kind === 'warmup'}>
            <button
              class="idx num"
              onclick={() => toggleKind(entry.id, entry.kind)}
              aria-label={entry.kind === 'warmup' ? 'Reclasser en série de travail' : 'Reclasser en échauffement'}
            >{entry.kind === 'warmup' ? 'éch.' : entry.set_index}</button>
            <input
              class="cell num"
              type="text"
              inputmode="decimal"
              value={kg(entry.weight_kg)}
              aria-label="Charge de la série {entry.set_index}"
              onchange={(e) => commitWeight(entry.id, e.currentTarget.value)}
            />
            <span class="unit">kg</span>
            <input
              class="cell num"
              type="number"
              inputmode="numeric"
              value={entry.reps}
              aria-label="Répétitions de la série {entry.set_index}"
              onchange={(e) => commitReps(entry.id, e.currentTarget.value)}
            />
            <span class="unit">reps</span>
            <button class="drop" onclick={() => store.removeSet(entry.id)} aria-label="Supprimer la série {entry.set_index}">✕</button>
          </div>
        {/each}
      </section>
    {:else}
      <p class="empty">Aucune série enregistrée dans cette séance.</p>
    {/each}

    <section class="band">
      <div class="eyebrow"><span class="label">Note</span></div>
      <textarea
        class="field note"
        rows="3"
        placeholder="Ce qu'il faut se rappeler la prochaine fois."
        bind:value={note}
        onblur={() => store.annotateSession(session.id, note)}
      ></textarea>
    </section>
  </div>
{:else}
  <Header title="Séance introuvable" />
  <p class="empty">Cette séance n'est pas dans les 90 derniers jours.</p>
{/if}

<style>
  .small { min-height: 38px; padding: 0 12px; font-size: 0.8125rem; }

  .line {
    display: grid;
    grid-template-columns: 48px 88px auto 68px auto 44px;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }

  /* Le numero est aussi le bouton qui reclasse la serie : pas de colonne en
     plus pour une correction rare mais indispensable. */
  .idx {
    height: 44px;
    font-size: 0.8125rem;
    color: var(--ink-faint);
    text-align: left;
  }
  .warm .cell { color: var(--ink-faint); }
  .warm .idx { color: var(--ink-dim); }

  .cell {
    height: 44px;
    padding: 0 8px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 1.25rem;
    text-align: right;
  }
  .cell:focus { border-color: var(--accent); outline: none; }

  .drop { width: 44px; height: 44px; color: var(--ink-faint); }

  .note { min-height: 76px; padding: 10px 12px; resize: vertical; line-height: 1.45; }

  /* Correction a posteriori : ecran de bureau, on garde une mesure lisible et
     des champs plus larges qu'au pouce. */
  @media (min-width: 860px) {
    .line { grid-template-columns: 52px 120px auto 96px auto 44px; max-width: 560px; }
    .note { max-width: 720px; }
  }
</style>
