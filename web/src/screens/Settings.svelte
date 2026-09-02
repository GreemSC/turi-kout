<script lang="ts">
  import { store } from '../lib/store.svelte.ts';
  import { kg } from '../lib/format.ts';
  import Header from '../lib/Header.svelte';

  let kcal = $state(0);
  let protein = $state(0);
  let gain = $state(0);
  let savingTargets = $state(false);

  $effect(() => {
    kcal = store.settings.kcal_target;
    protein = store.settings.protein_target_g;
    gain = store.settings.weekly_gain_target_kg;
  });

  // --- Entrainement ---------------------------------------------------------
  // Le RPE et l'echauffement propose sont eteints par defaut : ils ajoutent une
  // rangee a l'ecran de seance, ce qui ne doit jamais etre impose.

  async function toggle(key: 'rpe_enabled' | 'warmup_enabled') {
    await store.saveSettings({ [key]: store.settings[key] === 1 ? 0 : 1 });
  }

  let deload = $state(10);
  $effect(() => { deload = store.settings.deload_percent; });

  // --- Materiel -------------------------------------------------------------

  interface PlateDraft { weight_kg: number; count: number }

  let plates = $state<PlateDraft[]>([]);
  let dumbbells = $state<number[]>([]);
  let equipmentDirty = $state(false);
  let equipmentLoaded = $state(false);

  $effect(() => {
    if (equipmentLoaded || store.equipment.length === 0) return;
    equipmentLoaded = true;
    plates = store.equipment.filter((i) => i.kind === 'plate')
      .map((i) => ({ weight_kg: i.weight_kg, count: i.count }))
      .sort((a, b) => b.weight_kg - a.weight_kg);
    dumbbells = store.equipment.filter((i) => i.kind === 'dumbbell')
      .map((i) => i.weight_kg).sort((a, b) => a - b);
  });

  function addPlate() {
    plates.push({ weight_kg: 1.25, count: 2 });
    equipmentDirty = true;
  }

  function removePlate(index: number) {
    plates.splice(index, 1);
    equipmentDirty = true;
  }

  // Saisir vingt halteres un par un n'a pas de sens : on decrit la gamme.
  let ladderFrom = $state(2);
  let ladderTo = $state(40);
  let ladderStep = $state(2);

  function generateLadder() {
    const out: number[] = [];
    const step = Math.max(0.5, Number(ladderStep) || 2);
    for (let w = Number(ladderFrom); w <= Number(ladderTo) + 1e-9; w += step) {
      out.push(Math.round(w * 4) / 4);
    }
    dumbbells = out;
    equipmentDirty = true;
  }

  function removeDumbbell(weight: number) {
    dumbbells = dumbbells.filter((w) => w !== weight);
    equipmentDirty = true;
  }

  async function saveEquipment() {
    await store.saveEquipment([
      ...$state.snapshot(plates)
        .filter((p) => p.weight_kg > 0)
        .map((p) => ({ kind: 'plate' as const, weight_kg: Number(p.weight_kg), count: Math.max(1, Number(p.count) || 1) })),
      ...$state.snapshot(dumbbells).map((w) => ({ kind: 'dumbbell' as const, weight_kg: w, count: 1 })),
    ]);
    equipmentDirty = false;
  }

  async function saveTargets(event: SubmitEvent) {
    event.preventDefault();
    savingTargets = true;
    try {
      await store.saveSettings({
        kcal_target: Math.round(Number(kcal)),
        protein_target_g: Math.round(Number(protein)),
        weekly_gain_target_kg: Number(String(gain).replace(',', '.')),
      });
    } finally {
      savingTargets = false;
    }
  }

  // --- Repas recurrents (section 5.4) ---------------------------------------
  interface MealDraft { name: string; kcal: number; protein_g: number }

  let meals = $state<MealDraft[]>([]);
  let mealsDirty = $state(false);
  let loaded = $state(false);

  $effect(() => {
    if (loaded) return;
    loaded = true;
    meals = store.mealTemplates.map((t) => ({ name: t.name, kcal: t.kcal, protein_g: t.protein_g }));
  });

  function addMeal() {
    meals.push({ name: '', kcal: 0, protein_g: 0 });
    mealsDirty = true;
  }

  function removeMeal(index: number) {
    meals.splice(index, 1);
    mealsDirty = true;
  }

  async function saveMeals() {
    const clean = $state.snapshot(meals)
      .filter((m) => m.name.trim())
      .map((m) => ({ name: m.name.trim(), kcal: Math.round(Number(m.kcal) || 0), protein_g: Math.round(Number(m.protein_g) || 0) }));
    await store.saveMealTemplates(clean);
    meals = clean;
    mealsDirty = false;
  }
</script>

<Header title="Réglages" />

<div class="screen cols">
  <section class="band">
    <div class="eyebrow"><span class="label">Cibles quotidiennes</span></div>
    <form onsubmit={saveTargets} class="targets">
      <label><span class="unit">calories</span>
        <input class="field num" type="number" inputmode="numeric" min="0" bind:value={kcal} />
      </label>
      <label><span class="unit">protéines (g)</span>
        <input class="field num" type="number" inputmode="numeric" min="0" bind:value={protein} />
      </label>
      <label><span class="unit">prise visée (kg/semaine)</span>
        <input class="field num" type="number" step="0.05" min="-2" max="2" bind:value={gain} />
      </label>
      <button class="btn btn-accent" type="submit" disabled={savingTargets}>
        {savingTargets ? 'Enregistrement…' : 'Enregistrer les cibles'}
      </button>
    </form>
  </section>

  <section class="band">
    <div class="eyebrow">
      <span class="label">Entraînement</span>
      <span class="label">écran de séance</span>
    </div>

    <div class="switches">
      <button class="switch" aria-pressed={store.settings.rpe_enabled === 1} onclick={() => toggle('rpe_enabled')}>
        <span class="grow stack">
          <span class="switch-name">Saisir le RPE</span>
          <span class="unit">Effort perçu de 6 à 10 : une rangée de plus sous les répétitions,
            facultative à chaque série. Renseigné sur toutes les séries d'une séance, il affine
            la charge proposée — effort bas (6-7) fait sauter deux incréments, effort maximal
            (9-10) fait consolider. Sans RPE, la progression ne change pas.</span>
        </span>
        <span class="pill" class:on={store.settings.rpe_enabled === 1}></span>
      </button>

      <button class="switch" aria-pressed={store.settings.warmup_enabled === 1} onclick={() => toggle('warmup_enabled')}>
        <span class="grow stack">
          <span class="switch-name">Échauffement guidé</span>
          <span class="unit">Ouvre une échelle de paliers au début de chaque exercice qui le mérite :
            de la barre à vide jusqu'à 85 % de la charge, deux à quatre paliers selon le poids,
            un repos court entre chacun. Rien sous 25 kg. Les séries d'échauffement ne comptent
            dans aucune statistique.</span>
        </span>
        <span class="pill" class:on={store.settings.warmup_enabled === 1}></span>
      </button>
    </div>

    <label class="deload"><span class="unit">allègement proposé après stagnation (%)</span>
      <input
        class="field num" type="number" min="0" max="50" step="5" bind:value={deload}
        onchange={() => store.saveSettings({ deload_percent: Math.round(Number(deload)) })}
      />
    </label>
  </section>

  <!--
    L'inventaire decide de l'arrondi des charges : sans lui, l'application
    propose 82,5 kg a qui n'a pas de disques de 1,25.
  -->
  <section class="band">
    <div class="eyebrow">
      <span class="label">Matériel</span>
      <span class="label">disques disponibles, par paires</span>
    </div>

    {#each plates as plate, index (index)}
      <div class="plate-row">
        <input class="field num" type="number" step="0.25" min="0.25" bind:value={plate.weight_kg} oninput={() => (equipmentDirty = true)} aria-label="Poids du disque" />
        <span class="unit">kg ×</span>
        <input class="field num" type="number" min="1" max="20" bind:value={plate.count} oninput={() => (equipmentDirty = true)} aria-label="Nombre de paires" />
        <span class="unit">paires</span>
        <button class="icon" onclick={() => removePlate(index)} aria-label="Retirer ce disque">✕</button>
      </div>
    {:else}
      <p class="label">Aucun disque. Les charges seront arrondies à l'incrément de l'exercice.</p>
    {/each}

    <button class="btn btn-quiet add-plate" onclick={addPlate}>Ajouter un disque</button>

    <div class="eyebrow ladder-head">
      <span class="label">Haltères</span>
      <span class="label">{dumbbells.length} barreaux</span>
    </div>

    <div class="ladder">
      <label><span class="unit">de</span><input class="field num" type="number" min="0.5" step="0.5" bind:value={ladderFrom} /></label>
      <label><span class="unit">à</span><input class="field num" type="number" min="1" step="0.5" bind:value={ladderTo} /></label>
      <label><span class="unit">par pas de</span><input class="field num" type="number" min="0.5" step="0.5" bind:value={ladderStep} /></label>
      <button class="btn btn-quiet" onclick={generateLadder}>Régénérer</button>
    </div>

    {#if dumbbells.length}
      <div class="weights">
        {#each dumbbells as weight (weight)}
          <button class="weight" onclick={() => removeDumbbell(weight)} aria-label="Retirer l'haltère de {kg(weight)} kilos">
            <span class="num">{kg(weight)}</span>
          </button>
        {/each}
      </div>
    {/if}

    <button class="btn btn-block save-equipment" class:btn-accent={equipmentDirty} class:btn-quiet={!equipmentDirty} onclick={saveEquipment} disabled={!equipmentDirty}>
      {equipmentDirty ? 'Enregistrer le matériel' : 'Aucune modification'}
    </button>
  </section>

  <section class="band">
    <div class="eyebrow">
      <span class="label">Repas récurrents</span>
      <span class="label">loggables en un tap</span>
    </div>

    {#each meals as meal, index (index)}
      <div class="meal">
        <input class="field" placeholder="Petit-déj habituel" bind:value={meal.name} oninput={() => (mealsDirty = true)} aria-label="Nom du repas" />
        <input class="field num" type="number" inputmode="numeric" placeholder="kcal" bind:value={meal.kcal} oninput={() => (mealsDirty = true)} aria-label="Calories" />
        <input class="field num" type="number" inputmode="numeric" placeholder="prot." bind:value={meal.protein_g} oninput={() => (mealsDirty = true)} aria-label="Protéines" />
        <button class="icon" onclick={() => removeMeal(index)} aria-label="Supprimer {meal.name || 'le repas'}">✕</button>
      </div>
    {:else}
      <p class="label">Enregistrez ce que vous mangez réellement : une dizaine de repas suffit.</p>
    {/each}

    <div class="row actions">
      <button class="btn btn-quiet" onclick={addMeal}>Ajouter un repas</button>
      <button class="btn grow" class:btn-accent={mealsDirty} class:btn-quiet={!mealsDirty} onclick={saveMeals} disabled={!mealsDirty}>Enregistrer</button>
    </div>
  </section>

  <section class="band">
    <div class="eyebrow"><span class="label">Données</span></div>
    <p class="label spaced">
      L'export contient l'intégralité de la base au format JSON, réimportable tel quel.
    </p>
    <a class="btn btn-block" href="/api/export" download>Exporter tout (JSON)</a>
  </section>

  <section class="band">
    <div class="eyebrow"><span class="label">Accès</span></div>
    <p class="label spaced">
      {store.pending > 0
        ? `${store.pending} écriture(s) en attente d'envoi. Attendez la synchronisation avant de vous déconnecter.`
        : 'Toutes les données sont synchronisées.'}
    </p>
    <button class="btn btn-danger btn-block" onclick={() => store.signOut()}>
      Se déconnecter et effacer les données locales
    </button>
  </section>
</div>

<style>
  .targets, .meal { display: flex; flex-direction: column; gap: 8px; }
  .targets label { display: flex; flex-direction: column; gap: 3px; }

  .meal {
    display: grid;
    grid-template-columns: 1fr 76px 70px 44px;
    gap: 6px;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid var(--line);
  }
  .meal .num { text-align: center; padding: 0 4px; }

  .icon {
    width: 44px;
    height: 44px;
    border: 1px solid var(--line);
    border-radius: 2px;
    color: var(--ink-faint);
  }

  .actions { margin-top: 14px; }
  .spaced { margin-bottom: 12px; }

  /* --- Interrupteurs --- */

  .switches { display: flex; flex-direction: column; }

  .switch {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    width: 100%;
    text-align: left;
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }
  .switch-name { font-size: 0.9375rem; font-weight: 550; margin-bottom: 3px; }

  .pill {
    width: 42px;
    height: 24px;
    flex: none;
    margin-top: 2px;
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    position: relative;
  }
  .pill::after {
    content: '';
    position: absolute;
    top: 3px; left: 3px;
    width: 16px; height: 16px;
    border-radius: 50%;
    background: var(--ink-faint);
  }
  .pill.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .pill.on::after { left: 21px; background: var(--accent); }

  .deload { display: flex; flex-direction: column; gap: 3px; margin-top: 14px; max-width: 320px; }

  /* --- Materiel --- */

  .plate-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
  }
  .plate-row .num { width: 88px; text-align: center; }

  .add-plate { margin-top: 10px; }

  .ladder-head { margin-top: 22px; }
  .ladder {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px;
  }
  .ladder label { display: flex; flex-direction: column; gap: 3px; }
  .ladder .num { width: 84px; text-align: center; }

  .weights { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 12px; }
  .weight {
    min-width: 46px;
    height: 34px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 2px;
    color: var(--ink-dim);
    font-size: 0.8125rem;
  }

  .save-equipment { margin-top: 18px; }

  @media (hover: hover) {
    .weight:hover { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
    .icon:hover { color: var(--red); }
  }

  @media (min-width: 860px) {
    .targets { max-width: 420px; }
    .switch { max-width: 620px; }
    .targets .btn { align-self: flex-start; padding: 0 24px; }
    .meal { grid-template-columns: minmax(0, 1fr) 96px 88px 44px; }
  }

  a.btn { text-decoration: none; }
</style>
