<script lang="ts">
  import { store, todayKey } from '../lib/store.svelte.ts';
  import { router, paths } from '../lib/router.svelte.ts';
  import { restTimer, ensureNotifications } from '../lib/timer.svelte.ts';
  import { bodyweightSeries, nextRoutineDay, weeklyTrend } from '../../../shared/domain.ts';
  import { kg, scheme } from '../lib/format.ts';
  import { viewport } from '../lib/media.svelte.ts';
  import Header from '../lib/Header.svelte';

  const today = $derived(todayKey());
  const open = $derived(store.openSession);
  const suggestedDay = $derived(nextRoutineDay(store.routineDays, store.sessions));

  let chosenDayId = $state<number | null>(null);
  const day = $derived(store.routineDays.find((d) => d.id === chosenDayId) ?? suggestedDay);
  const slots = $derived(day ? store.slotsFor(day.id) : []);

  // --- Poids corporel -------------------------------------------------------
  const trend = $derived.by(() => {
    const series = bodyweightSeries($state.snapshot(store.bodyweights), 90);
    return weeklyTrend(series, store.settings.weekly_gain_target_kg);
  });
  const todayWeight = $derived(store.bodyweightOn(today));

  // Sur ecran large il y a la place : les deux panneaux sont deployes d'office,
  // les replier ne ferait economiser aucun espace utile.
  let weighing = $state(false);
  const showWeighIn = $derived(weighing || viewport.wide);

  let weightDraft = $state('');
  $effect(() => { weightDraft = todayWeight !== null ? String(todayWeight).replace('.', ',') : ''; });

  function saveWeight(event: SubmitEvent) {
    event.preventDefault();
    const value = Number(weightDraft.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return;
    store.setBodyweight(today, Math.round(value * 10) / 10);
    weighing = false;
  }

  // --- Nutrition ------------------------------------------------------------
  const meals = $derived(store.foodOn(today));
  const kcal = $derived(meals.reduce((sum, m) => sum + m.kcal, 0));
  const protein = $derived(meals.reduce((sum, m) => sum + m.protein_g, 0));

  let eating = $state(false);
  const showMeals = $derived(eating || viewport.wide);
  let freeLabel = $state('');
  let freeKcal = $state('');
  let freeProtein = $state('');

  function logFree(event: SubmitEvent) {
    event.preventDefault();
    const k = Number(freeKcal);
    if (!Number.isFinite(k)) return;
    store.logFood({
      label: freeLabel.trim() || 'Écart',
      kcal: Math.round(k),
      protein_g: Math.round(Number(freeProtein) || 0),
    });
    freeLabel = ''; freeKcal = ''; freeProtein = '';
  }

  function begin() {
    if (!day) return;
    const session = open ?? store.startSession(day.id);
    void ensureNotifications();
    void restTimer.holdScreen();
    if (session) router.go(paths.workout);
  }
</script>

<Header title="Turi Kout" sub={new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())} />

<div class="screen home">
  <!-- Section 6 : la prochaine seance et un unique bouton pour la demarrer. -->
  <section class="band next">
    <div class="eyebrow">
      <span class="label">{open ? 'Séance en cours' : 'Prochaine séance'}</span>
      {#if !open && chosenDayId !== null && suggestedDay && chosenDayId !== suggestedDay.id}
        <button class="link" onclick={() => (chosenDayId = null)}>revenir à {suggestedDay.name}</button>
      {/if}
    </div>

    {#if open}
      {@const openDay = store.routineDay(open.routine_day_id)}
      <h2 class="daytitle">{openDay?.name ?? 'Séance'}</h2>
      <p class="label">{store.setsOf(open.id).length} séries déjà enregistrées.</p>
    {:else if day}
      <h2 class="daytitle">{day.name}</h2>
      <ul class="plan">
        {#each slots as slot (slot.id)}
          <li>
            <span class="grow truncate">{store.exercise(slot.exercise_id)?.name ?? '—'}</span>
            <span class="unit">{scheme(slot.target_sets, slot.rep_min, slot.rep_max)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="label">Aucune journée dans le programme. Ajoutez-en une dans Programme.</p>
    {/if}

    <button class="btn btn-accent btn-xl btn-block start" onclick={begin} disabled={!day && !open}>
      {open ? 'Reprendre la séance' : `Démarrer ${day?.name ?? ''}`}
    </button>

    {#if !open && store.routineDays.length > 1}
      <div class="picker" role="group" aria-label="Choisir une autre journée">
        {#each store.routineDays as d (d.id)}
          <button class:on={day?.id === d.id} onclick={() => (chosenDayId = d.id)}>{d.name}</button>
        {/each}
      </div>
    {/if}
  </section>

  <div class="side">
  <!-- Poids du jour, en une ligne. Le detail s'ouvre sur place. -->
  <section class="band">
    <button class="oneline" onclick={() => (weighing = !weighing)} aria-expanded={showWeighIn}>
      <span class="label grow">Poids du jour</span>
      {#if todayWeight !== null}
        <span class="num num-m">{kg(todayWeight)}</span><span class="unit">kg</span>
      {:else}
        <span class="unit">non pesé</span>
      {/if}
    </button>
    <p class="label trend">{trend.label}</p>

    {#if showWeighIn}
      <form onsubmit={saveWeight} class="inline">
        <input class="field num" type="text" inputmode="decimal" placeholder="78,4" bind:value={weightDraft} aria-label="Poids en kilos" />
        <button class="btn btn-accent" type="submit">Enregistrer</button>
      </form>
    {/if}
  </section>

  <!-- Nutrition du jour, en une ligne. Section 5.4 : volontairement minimale. -->
  <section class="band">
    <button class="oneline" onclick={() => (eating = !eating)} aria-expanded={showMeals}>
      <span class="label grow">Aujourd'hui</span>
      <span class="num num-m">{kcal.toLocaleString('fr-FR')}</span><span class="unit">/ {store.settings.kcal_target.toLocaleString('fr-FR')} kcal</span>
      <span class="num num-m sep">{protein}</span><span class="unit">/ {store.settings.protein_target_g} g</span>
    </button>

    <div class="meters">
      <div class="meter"><span style:width="{Math.min(100, (kcal / Math.max(1, store.settings.kcal_target)) * 100)}%"></span></div>
      <div class="meter"><span style:width="{Math.min(100, (protein / Math.max(1, store.settings.protein_target_g)) * 100)}%"></span></div>
    </div>

    {#if showMeals}
      {#if store.mealTemplates.length}
        <div class="templates">
          {#each store.mealTemplates as template (template.id)}
            <button
              class="template"
              onclick={() => store.logFood({ label: template.name, kcal: template.kcal, protein_g: template.protein_g, templateId: template.id })}
            >
              <span class="grow truncate">{template.name}</span>
              <span class="unit">{template.kcal} kcal · {template.protein_g} g</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="label empty-note">Aucun repas enregistré. Créez vos repas récurrents dans Réglages pour les logger en un tap.</p>
      {/if}

      {#if meals.length}
        <ul class="logged">
          {#each meals as meal (meal.id)}
            <li>
              <span class="grow truncate">{meal.label}</span>
              <span class="unit">{meal.kcal} kcal · {meal.protein_g} g</span>
              <button class="drop" onclick={() => store.removeFood(meal.id)} aria-label="Supprimer {meal.label}">✕</button>
            </li>
          {/each}
        </ul>
      {/if}

      <form onsubmit={logFree} class="free">
        <input class="field" type="text" placeholder="Écart ponctuel" bind:value={freeLabel} aria-label="Intitulé" />
        <input class="field num" type="number" inputmode="numeric" placeholder="kcal" bind:value={freeKcal} aria-label="Calories" />
        <input class="field num" type="number" inputmode="numeric" placeholder="prot." bind:value={freeProtein} aria-label="Protéines en grammes" />
        <button class="btn" type="submit" disabled={!freeKcal}>Ajouter</button>
      </form>
    {/if}
  </section>
  </div>
</div>

<style>
  /* Telephone : les trois blocs s'empilent, le conteneur lateral disparait. */
  .side { display: contents; }

  .next { padding-bottom: 20px; }
  .daytitle { font-size: 2rem; letter-spacing: -0.035em; margin-bottom: 12px; }

  .plan {
    list-style: none;
    margin: 0 0 18px;
    padding: 0;
  }
  .plan li {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 5px 0;
    font-size: 0.9375rem;
    border-bottom: 1px solid var(--line);
  }
  .plan li:last-child { border-bottom: 0; }

  .start { margin-top: 4px; }

  .picker {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }
  .picker button {
    flex: 1;
    min-height: 40px;
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 0.75rem;
    font-weight: 550;
    color: var(--ink-faint);
  }
  .picker button.on { color: var(--ink); border-color: var(--line-strong); background: var(--surface); }

  .oneline {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    min-height: var(--tap);
    text-align: left;
    padding: 0;
  }
  .oneline .grow { text-align: left; }
  .sep { margin-left: 10px; }

  .trend { margin-top: -6px; }

  .inline {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .inline .field { flex: 1; font-size: 1.25rem; }

  .meters {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .meter {
    flex: 1;
    height: 3px;
    background: var(--line);
  }
  .meter span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  /* L'invitation prend la place qu'auraient occupee les repas : sans cette
     marge elle vient coller aux jauges. */
  .empty-note { margin-top: 16px; }

  .templates {
    display: flex;
    flex-direction: column;
    margin-top: 16px;
    border-top: 1px solid var(--line);
  }
  .template {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-height: var(--tap);
    padding: 8px 0;
    text-align: left;
    border-bottom: 1px solid var(--line);
    font-size: 0.9375rem;
  }

  .logged {
    list-style: none;
    margin: 14px 0 0;
    padding: 0;
  }
  .logged li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 0.875rem;
    color: var(--ink-dim);
    padding: 4px 0;
  }

  .drop {
    width: 40px;
    height: 40px;
    margin: -10px 0;
    color: var(--ink-faint);
  }

  .free {
    display: grid;
    grid-template-columns: 1fr 78px 78px;
    gap: 8px;
    margin-top: 14px;
  }
  .free .btn { grid-column: 1 / -1; }

  .link {
    font-size: 0.6875rem;
    color: var(--ink-dim);
    text-decoration: underline;
    padding: 0;
  }

  /* Bureau : la seance a venir occupe une colonne, le suivi quotidien l'autre.
     Les deux tiennent alors dans un ecran sans defilement. */
  @media (min-width: 860px) {
    .home {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
      align-items: start;
    }

    .side {
      display: block;
      border-left: 1px solid var(--line);
    }

    .next {
      border-bottom: 0;
      padding-bottom: 28px;
    }

    .daytitle { font-size: 2.5rem; }
    .start { max-width: 420px; }
    .picker { max-width: 420px; }
    .free { grid-template-columns: 1fr 96px 96px auto; }
    .free .btn { grid-column: auto; }
  }
</style>
