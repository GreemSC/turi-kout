<script lang="ts">
  // Ecran de bureau : on y touche au calme, entre deux seances. Les
  // modifications partent directement vers le serveur, pas par la file hors
  // ligne, qui est reservee a ce qui se saisit en salle.
  import { store } from '../lib/store.svelte.ts';
  import type { Equipment } from '../../../shared/types.ts';
  import Header from '../lib/Header.svelte';
  import ExerciseDiagram from '../lib/ExerciseDiagram.svelte';

  interface Draft {
    exercise_id: number;
    target_sets: number;
    rep_min: number;
    rep_max: number;
    rest_seconds: number;
    superset_group: number | null;
  }

  const EQUIPMENT: [Equipment, string][] = [
    ['barbell', 'Barre'],
    ['dumbbell', 'Haltères'],
    ['machine', 'Machine'],
    ['cable', 'Poulie'],
    ['bodyweight', 'Poids du corps'],
  ];

  let dayId = $state<number | null>(null);
  const day = $derived(store.routineDays.find((d) => d.id === dayId) ?? store.routineDays[0]);

  let draft = $state<Draft[]>([]);
  let name = $state('');
  let dirty = $state(false);
  let saving = $state(false);
  let saved = $state(false);

  // Recharge le brouillon quand on change de journee, sans ecraser une edition
  // en cours.
  let loadedFor = $state<number | null>(null);
  $effect(() => {
    if (!day || loadedFor === day.id) return;
    loadedFor = day.id;
    name = day.name;
    draft = store.slotsFor(day.id).map((s) => ({
      exercise_id: s.exercise_id,
      target_sets: s.target_sets,
      rep_min: s.rep_min,
      rep_max: s.rep_max,
      rest_seconds: s.rest_seconds,
      superset_group: s.superset_group,
    }));
    dirty = false;
    saved = false;
  });

  const available = $derived(store.exercises.filter((e) => !e.archived_at));

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= draft.length) return;
    [draft[index], draft[target]] = [draft[target], draft[index]];
    dirty = true;
  }

  function remove(index: number) {
    draft.splice(index, 1);
    dirty = true;
  }

  function add(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const id = Number(select.value);
    if (!id) return;
    draft.push({ exercise_id: id, target_sets: 3, rep_min: 8, rep_max: 12, rest_seconds: 90, superset_group: null });
    select.value = '';
    dirty = true;
  }

  /**
   * Lie un exercice au precedent : ils s'enchainent alors sans repos
   * intermediaire. Le groupe se defait des qu'il ne reste qu'un membre.
   */
  function toggleLink(index: number) {
    if (index === 0) return;
    const current = draft[index];
    const previous = draft[index - 1];

    if (current.superset_group !== null && current.superset_group === previous.superset_group) {
      const group = current.superset_group;
      current.superset_group = null;
      if (draft.filter((s) => s.superset_group === group).length < 2) {
        for (const slot of draft) if (slot.superset_group === group) slot.superset_group = null;
      }
    } else {
      const used = draft.map((s) => s.superset_group ?? 0);
      const group = previous.superset_group ?? Math.max(0, ...used) + 1;
      previous.superset_group = group;
      current.superset_group = group;
    }
    dirty = true;
  }

  const linkedToPrevious = (index: number) =>
    index > 0 && draft[index].superset_group !== null && draft[index].superset_group === draft[index - 1].superset_group;

  async function save() {
    if (!day || saving) return;
    saving = true;
    try {
      if (name.trim() && name.trim() !== day.name) await store.renameDay(day.id, name.trim());
      await store.saveRoutine(day.id, $state.snapshot(draft));
      dirty = false;
      saved = true;
    } finally {
      saving = false;
    }
  }

  // --- Catalogue d'exercices -------------------------------------------------
  // Le materiel decide de l'arrondi des charges, la cartographie musculaire
  // alimente le volume hebdomadaire. Sans eux, un exercice cree a la main ne
  // compte nulle part.

  let editing = $state<number | null>(null);

  async function setEquipment(exerciseId: number, equipment: Equipment) {
    const current = store.exercise(exerciseId);
    await store.updateExercise(exerciseId, {
      equipment,
      bar_kg: equipment === 'barbell' ? 20 : null,
      // Un exercice au poids du corps sans coefficient reste invisible dans le
      // tonnage et les records : on le suppose porte en entier.
      bodyweight_factor: equipment === 'bodyweight' ? (current?.bodyweight_factor ?? 1) : null,
    });
  }

  async function toggleUnilateral(exerciseId: number) {
    const current = store.exercise(exerciseId);
    await store.updateExercise(exerciseId, { unilateral: current?.unilateral === 1 ? 0 : 1 });
  }

  async function setFactor(exerciseId: number, value: string) {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
      await store.updateExercise(exerciseId, { bodyweight_factor: parsed });
    }
  }

  /** Chaque tap fait tourner : absent → moteur (1,0) → synergiste (0,5) → absent. */
  async function cycleMuscle(exerciseId: number, muscleId: string) {
    const rows = store.musclesOf(exerciseId).map((m) => ({ muscle_id: m.muscle_id, share: m.share }));
    const found = rows.find((r) => r.muscle_id === muscleId);

    let next: typeof rows;
    if (!found) next = [...rows, { muscle_id: muscleId, share: 1 }];
    else if (found.share === 1) next = rows.map((r) => (r.muscle_id === muscleId ? { ...r, share: 0.5 } : r));
    else next = rows.filter((r) => r.muscle_id !== muscleId);

    await store.saveExerciseMuscles(exerciseId, next);
  }

  const shareOf = (exerciseId: number, muscleId: string) =>
    store.musclesOf(exerciseId).find((m) => m.muscle_id === muscleId)?.share ?? 0;

  /**
   * Remplacants possibles : les exercices qui partagent au moins un muscle.
   * Proposer les quarante autres n'aiderait personne.
   */
  function candidates(exerciseId: number) {
    const mine = new Set(store.musclesOf(exerciseId).map((m) => m.muscle_id));
    return available
      .filter((e) => e.id !== exerciseId && store.musclesOf(e.id).some((m) => mine.has(m.muscle_id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function toggleAlternative(exerciseId: number, otherId: number) {
    const current = store.alternativesOf(exerciseId).map((e) => e.id);
    const next = current.includes(otherId) ? current.filter((id) => id !== otherId) : [...current, otherId];
    await store.saveAlternatives(exerciseId, next);
  }

  let newName = $state('');
  let newGroup = $state('');
  let newIncrement = $state(2.5);
  let newEquipment = $state<Equipment>('barbell');

  async function createExercise(event: SubmitEvent) {
    event.preventDefault();
    if (!newName.trim() || !newGroup.trim()) return;
    const created = await store.addExercise({
      name: newName.trim(),
      muscle_group: newGroup.trim(),
      increment_kg: Number(newIncrement) || 2.5,
      is_bodyweight: newEquipment === 'bodyweight' ? 1 : 0,
      equipment: newEquipment,
    });
    newName = ''; newGroup = '';
    // Sans muscle, il ne comptera dans aucun volume : on ouvre l'editeur.
    editing = created.id;
  }
</script>

<Header title="Programme" sub="Rotation continue, sans jour de la semaine" />

<div class="screen">
  <nav class="days">
    {#each store.routineDays as d (d.id)}
      <button class:on={day?.id === d.id} onclick={() => (dayId = d.id)}>
        <span class="pos num">{d.position}</span>{d.name}
      </button>
    {/each}
  </nav>

  {#if day}
    <section class="band">
      <div class="eyebrow"><span class="label">Nom de la journée</span></div>
      <input class="field" bind:value={name} oninput={() => (dirty = true)} aria-label="Nom de la journée" />
    </section>

    <section class="band">
      <div class="eyebrow">
        <span class="label">Exercices</span>
        <span class="label wide-hidden">séries × reps · repos</span>
      </div>

      {#if draft.length}
        <div class="slot heads" aria-hidden="true">
          <span></span>
          <span class="unit">séries</span>
          <span class="unit">reps min</span>
          <span class="unit">reps max</span>
          <span class="unit">repos (s)</span>
          <span></span>
        </div>
      {/if}

      {#each draft as slot, index (index)}
        <div class="slot" class:linked={linkedToPrevious(index)}>
          <div class="slot-head">
            <span class="grow truncate">{store.exercise(slot.exercise_id)?.name ?? '—'}</span>
          </div>
          <div class="slot-fields">
            <label><span class="unit">séries</span>
              <input class="field num" type="number" min="1" max="20" bind:value={slot.target_sets} oninput={() => (dirty = true)} />
            </label>
            <label><span class="unit">reps min</span>
              <input class="field num" type="number" min="1" max="100" bind:value={slot.rep_min} oninput={() => (dirty = true)} />
            </label>
            <label><span class="unit">reps max</span>
              <input class="field num" type="number" min="1" max="100" bind:value={slot.rep_max} oninput={() => (dirty = true)} />
            </label>
            <label><span class="unit">repos (s)</span>
              <input class="field num" type="number" min="0" max="900" step="15" bind:value={slot.rest_seconds} oninput={() => (dirty = true)} />
            </label>
          </div>
          <div class="slot-actions">
            <button
              class="icon"
              class:on={linkedToPrevious(index)}
              disabled={index === 0}
              onclick={() => toggleLink(index)}
              aria-pressed={linkedToPrevious(index)}
              aria-label="Enchaîner en superset avec l'exercice précédent"
            >lier</button>
            <button class="icon" onclick={() => move(index, -1)} disabled={index === 0} aria-label="Monter">↑</button>
            <button class="icon" onclick={() => move(index, 1)} disabled={index === draft.length - 1} aria-label="Descendre">↓</button>
            <button class="icon" onclick={() => remove(index)} aria-label="Retirer">✕</button>
          </div>
        </div>
      {:else}
        <p class="label">Aucun exercice dans cette journée.</p>
      {/each}

      <select class="field add" onchange={add} aria-label="Ajouter un exercice">
        <option value="">Ajouter un exercice…</option>
        {#each available as exercise (exercise.id)}
          <option value={exercise.id}>{exercise.name} — {exercise.muscle_group}</option>
        {/each}
      </select>
    </section>

    <section class="band sticky">
      <button class="btn btn-block" class:btn-accent={dirty} class:btn-quiet={!dirty} onclick={save} disabled={!dirty || saving}>
        {saving ? 'Enregistrement…' : dirty ? 'Enregistrer la journée' : saved ? 'Enregistré' : 'Aucune modification'}
      </button>
    </section>
  {/if}

  <section class="band">
    <div class="eyebrow">
      <span class="label">Catalogue d'exercices</span>
      <span class="label">matériel et muscles travaillés</span>
    </div>

    <ul class="catalogue">
      {#each available as exercise (exercise.id)}
        {@const muscles = store.musclesOf(exercise.id)}
        <li>
          <button class="cat-head" onclick={() => (editing = editing === exercise.id ? null : exercise.id)} aria-expanded={editing === exercise.id}>
            <span class="cat-thumb"><ExerciseDiagram key={exercise.diagram} label={exercise.name} height={34} /></span>
            <span class="grow truncate">{exercise.name}</span>
            <span class="unit">{EQUIPMENT.find(([id]) => id === exercise.equipment)?.[1] ?? exercise.equipment}</span>
            {#if exercise.unilateral === 1}<span class="unit">un côté</span>{/if}
            <span class="unit" class:danger={muscles.length === 0}>
              {muscles.length ? `${muscles.length} muscles` : 'aucun muscle'}
            </span>
          </button>

          {#if editing === exercise.id}
            <div class="editor">
              <div class="equipment" role="group" aria-label="Matériel">
                {#each EQUIPMENT as [id, wording] (id)}
                  <button class:on={exercise.equipment === id} onclick={() => setEquipment(exercise.id, id)}>{wording}</button>
                {/each}
              </div>

              <div class="flags">
                <button class="flag" class:on={exercise.unilateral === 1} onclick={() => toggleUnilateral(exercise.id)} aria-pressed={exercise.unilateral === 1}>
                  Un côté à la fois
                </button>
                {#if exercise.equipment === 'bodyweight'}
                  <label class="factor"><span class="unit">part du poids de corps</span>
                    <input
                      class="field num" type="number" step="0.05" min="0.05" max="1"
                      value={exercise.bodyweight_factor ?? 1}
                      onchange={(e) => setFactor(exercise.id, e.currentTarget.value)}
                    />
                  </label>
                {/if}
              </div>

              <p class="label hint">
                {#if exercise.unilateral === 1}
                  Les répétitions sont comptées par membre : le tonnage compte double.
                {/if}
                {#if exercise.equipment === 'bodyweight'}
                  La charge saisie est le lest — négative pour une assistance. Le poids
                  du corps du jour s'y ajoute, sans quoi l'exercice ne pèserait rien.
                {/if}
              </p>

              <p class="label hint">
                Un tap fait tourner : moteur (1,0), synergiste (0,5), aucun. Le volume
                hebdomadaire compte 1 set pour le moteur et un demi pour chaque synergiste.
              </p>

              <p class="label hint">Remplaçants — proposés en séance quand la machine est prise.</p>
              <div class="muscle-grid">
                {#each candidates(exercise.id) as option (option.id)}
                  {@const chosen = store.alternativesOf(exercise.id).some((e) => e.id === option.id)}
                  <button class="muscle" class:primary={chosen} onclick={() => toggleAlternative(exercise.id, option.id)}>
                    {option.name}
                  </button>
                {/each}
              </div>

              <p class="label hint">Muscles travaillés.</p>
              <div class="muscle-grid">
                {#each store.muscles as muscle (muscle.id)}
                  {@const share = shareOf(exercise.id, muscle.id)}
                  <button
                    class="muscle"
                    class:primary={share === 1}
                    class:synergist={share === 0.5}
                    onclick={() => cycleMuscle(exercise.id, muscle.id)}
                  >
                    {muscle.name}
                    {#if share > 0}<span class="num share">{share === 1 ? '1' : '0,5'}</span>{/if}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <section class="band">
    <div class="eyebrow"><span class="label">Nouvel exercice</span></div>
    <form onsubmit={createExercise} class="newex">
      <input class="field" placeholder="Nom" bind:value={newName} aria-label="Nom de l'exercice" />
      <input class="field" placeholder="Groupe musculaire" bind:value={newGroup} aria-label="Groupe musculaire" />
      <label class="pick"><span class="unit">matériel</span>
        <select class="field" bind:value={newEquipment}>
          {#each EQUIPMENT as [id, wording] (id)}<option value={id}>{wording}</option>{/each}
        </select>
      </label>
      <label class="pick"><span class="unit">incrément (kg)</span>
        <input class="field num" type="number" step="0.25" min="0" bind:value={newIncrement} />
      </label>
      <button class="btn" type="submit" disabled={!newName.trim() || !newGroup.trim()}>Créer</button>
    </form>
  </section>
</div>

<style>
  .days {
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--line);
  }
  .days::-webkit-scrollbar { display: none; }
  .days button {
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    padding: 0 16px;
    height: 48px;
    font-size: 0.875rem;
    font-weight: 550;
    color: var(--ink-faint);
    border-bottom: 2px solid transparent;
  }
  .days button.on { color: var(--ink); border-bottom-color: var(--accent); }
  .pos { font-size: 0.6875rem; color: var(--ink-faint); }

  .slot {
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }
  /* Un maillon de superset se rattache visuellement au precedent. */
  .slot.linked { border-left: 2px solid var(--line-strong); padding-left: 10px; margin-top: -12px; }

  .slot-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.9375rem;
    font-weight: 550;
    margin-bottom: 8px;
  }

  .slot-actions {
    display: flex;
    gap: 4px;
    margin-top: 8px;
  }

  /* L'en-tete de colonnes n'a de sens que quand une ligne tient sur une ligne. */
  .heads { display: none; }

  .icon {
    min-width: 40px;
    padding: 0 6px;
    height: 40px;
    font-size: 0.75rem;
    color: var(--ink-faint);
    border: 1px solid var(--line);
    border-radius: 2px;
    flex: none;
  }
  .icon.on { color: var(--ink); border-color: var(--line-strong); background: var(--surface); }

  .slot-fields {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .slot-fields label { display: flex; flex-direction: column; gap: 3px; }
  .slot-fields .field { text-align: center; padding: 0 4px; }

  .add { margin-top: 14px; }

  .sticky { position: sticky; bottom: calc(var(--tap) + var(--bottom-safe)); background: var(--bg); }

  /* --- Catalogue --- */

  .catalogue { list-style: none; margin: 0; padding: 0; }
  .catalogue li { border-bottom: 1px solid var(--line); }
  .catalogue li:last-child { border-bottom: 0; }

  .cat-thumb {
    width: 60px;
    flex: none;
    border: 1px solid var(--line);
    border-radius: 2px;
    background: var(--surface);
    padding: 1px;
  }

  .cat-head {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: var(--tap);
    padding: 8px 0;
    text-align: left;
    font-size: 0.9375rem;
  }

  .editor { padding: 4px 0 16px; }

  .equipment { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .equipment button {
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 0.8125rem;
    color: var(--ink-faint);
  }
  .equipment button.on { color: var(--ink); border-color: var(--line-strong); background: var(--surface); }

  .hint { margin-bottom: 10px; }
  .hint:empty { display: none; }

  .flags {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
    margin-bottom: 12px;
  }
  .flag {
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 0.8125rem;
    color: var(--ink-faint);
  }
  .flag.on { color: var(--ink); border-color: var(--line-strong); background: var(--surface); }
  .factor { display: flex; flex-direction: column; gap: 3px; }
  .factor .num { width: 96px; text-align: center; }

  .muscle-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .muscle {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 0.8125rem;
    color: var(--ink-faint);
  }
  .muscle.primary { border-color: var(--accent); color: var(--accent); }
  .muscle.synergist { border-color: var(--line-strong); color: var(--ink-dim); }
  .share { font-size: 0.6875rem; }

  .newex { display: flex; flex-direction: column; gap: 8px; }
  .pick { display: flex; flex-direction: column; gap: 3px; }

  /* Bureau : un exercice tient sur une ligne, nom et reglages alignes en
     colonnes d'un exercice a l'autre. */
  @media (min-width: 860px) {
    .heads {
      display: grid;
      padding: 0 0 6px;
      border-bottom: 1px solid var(--line);
    }
    .heads .unit { text-align: center; }

    .wide-hidden { display: none; }

    .slot {
      display: grid;
      grid-template-columns: minmax(0, 1fr) repeat(4, 84px) auto;
      align-items: end;
      gap: 10px;
      padding: 10px 0;
    }
    .slot.linked { margin-top: 0; }

    .slot-head { margin-bottom: 0; align-self: center; }
    .slot-head .grow { font-size: 1rem; }
    .slot-actions { margin-top: 0; align-self: center; }

    .slot-fields { display: contents; }
    .slot-fields label { gap: 4px; }
    /* Les libelles sont portes par l'en-tete, plus par chaque ligne. */
    .slot-fields label > .unit { display: none; }

    .field, .add, .newex, .sticky { max-width: 720px; }
    .slot-fields .field { max-width: none; }
    .sticky { position: static; padding-top: 4px; }
    .newex { flex-direction: row; align-items: flex-end; flex-wrap: wrap; }
    .newex .field { flex: 1; min-width: 160px; }
  }

  @media (hover: hover) {
    .icon:not(:disabled):hover { color: var(--ink); border-color: var(--line-strong); }
    .slot-actions .icon:last-child:hover { color: var(--red); }
    .cat-head:hover { color: var(--ink); }
    .muscle:hover { border-color: var(--line-strong); }
  }
</style>
