<script lang="ts">
  import { untrack } from 'svelte';
  import { store } from '../lib/store.svelte.ts';
  import { router, paths } from '../lib/router.svelte.ts';
  import { restTimer, ensureNotifications } from '../lib/timer.svelte.ts';
  import {
    loadable, performanceHistory, suggestLoad, warmupRamp, workingSets,
  } from '../../../shared/domain.ts';
  import type { DetectedRecord } from '../../../shared/domain.ts';
  import type { SetKind } from '../../../shared/types.ts';
  import { ago, clock, kg, scheme } from '../lib/format.ts';
  import RestTimer from '../lib/RestTimer.svelte';
  import ExerciseDiagram from '../lib/ExerciseDiagram.svelte';
  import SyncBadge from '../lib/SyncBadge.svelte';
  import Plates from '../lib/Plates.svelte';

  const session = $derived(store.openSession);
  const day = $derived(session ? store.routineDay(session.routine_day_id) : undefined);
  const slots = $derived(session ? store.slotsFor(session.routine_day_id) : []);

  let index = $state(0);
  const slot = $derived(slots[Math.min(index, Math.max(0, slots.length - 1))]);
  /**
   * L'exercice prevu par le programme, et celui reellement fait : la machine
   * etait peut-etre prise. Tout ce qui suit — historique, suggestion, series,
   * rampe, schema — porte sur l'exercice REEL, sans quoi la charge proposee
   * viendrait d'un autre mouvement.
   */
  const plannedId = $derived(slot?.exercise_id ?? 0);
  const exerciseId = $derived(session && slot ? (store.swapFor(session.id, plannedId) ?? plannedId) : plannedId);
  const exercise = $derived(store.exercise(exerciseId));
  const swapped = $derived(exerciseId !== plannedId);
  const planned = $derived(swapped ? store.exercise(plannedId) : undefined);

  const alternatives = $derived(store.alternativesOf(plannedId));
  let choosing = $state(false);

  function chooseAlternative(id: number | null) {
    if (session) store.swapExercise(session.id, plannedId, id);
    choosing = false;
  }

  // Ouvrir le choix depuis le bas d'une seance avancee laisserait la liste
  // hors champ : on revient en haut.
  $effect(() => {
    if (!choosing) return;
    requestAnimationFrame(() => document.querySelector('.body')?.scrollTo({ top: 0 }));
  });

  // Section 5.2 : ce qui a ete fait la fois precedente sur ce meme exercice.
  // L'historique sert aussi a reperer une stagnation installee.
  const history = $derived(
    slot && session ? performanceHistory(store.sets, store.sessions, exerciseId, session.id, 5) : [],
  );
  const previous = $derived(history[0] ?? null);

  const suggestion = $derived(
    slot && exercise
      ? suggestLoad(previous, slot, exercise.increment_kg, {
          exercise,
          inventory: store.equipment,
          history,
          deloadPercent: store.settings.deload_percent,
        })
      : null,
  );

  const allToday = $derived(session && slot ? store.setsOfExercise(session.id, exerciseId) : []);
  const doneToday = $derived(workingSets(allToday));
  const warmupsToday = $derived(allToday.filter((s) => s.kind === 'warmup'));
  const nextSetIndex = $derived(doneToday.length + 1);

  const rpeOn = $derived(store.settings.rpe_enabled === 1);
  const warmupOn = $derived(store.settings.warmup_enabled === 1);

  /**
   * Charge de travail visee. C'est la suggestion quand l'exercice a un passe ;
   * la premiere fois, il n'y en a pas, et c'est ce que l'utilisateur saisit —
   * sans quoi il n'y aurait rien a partir de quoi construire une rampe.
   */
  let enteredTarget = $state(0);
  const workTarget = $derived(suggestion?.weight_kg || enteredTarget);

  /**
   * Valeurs pre-remplies. La premiere serie reprend la charge visee ; les
   * suivantes reprennent ce qui vient d'etre fait, parce que c'est ce qui se
   * passe reellement dans une serie de travail.
   */
  const prefill = $derived.by(() => {
    const last = doneToday[doneToday.length - 1];
    if (last) return { weight: last.weight_kg, reps: last.reps };
    return { weight: workTarget, reps: suggestion?.reps ?? slot?.rep_max ?? 8 };
  });

  let weight = $state(0);
  let reps = $state(8);
  let rpe = $state<number | null>(null);
  let announced = $state<DetectedRecord[]>([]);

  // Une note de seance ne se relit jamais ; une note attachee a l'exercice
  // qu'on a devant soi, si.
  const lastNote = $derived(
    slot && session ? store.lastNote(exerciseId, session.id) : null,
  );
  let noteOpen = $state(false);
  let noteDraft = $state('');
  $effect(() => {
    noteDraft = slot && session ? store.noteFor(exerciseId, session.id) : '';
    noteOpen = false;
  });

  /**
   * Garde sous les yeux la ligne qu'on s'apprete a remplir — palier
   * d'echauffement en cours ou serie a venir. Sans cela, une seance longue la
   * pousse sous la ligne de flottaison des la troisieme serie.
   *
   * La ligne est retrouvee dans le document plutot que liee : elle change de
   * nature selon qu'on echauffe ou qu'on travaille.
   */
  $effect(() => {
    void allToday.length;
    void slot?.id;
    void warmupIndex;
    void announced.length;

    // Deux trames d'attente : le bloc du dessus finit de se composer apres le
    // premier rendu, et defiler trop tot laisse la ligne sous la ligne de
    // flottaison. Deplacement instantane — la seule animation utile de
    // l'application est le decompte du minuteur.
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>('.rung.current')
        ?? document.querySelector<HTMLElement>('.pendingline');
      row?.scrollIntoView({ block: 'end', behavior: 'auto' });
    }));
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => {
    if (step) {
      weight = step.weightKg;
      reps = step.reps;
      rpe = null;
      return;
    }
    const values = prefill;
    weight = values.weight;
    reps = values.reps;
    rpe = null;
  });

  /**
   * Ouvre la rampe une fois par arrivee sur un exercice, et remet a zero ce qui
   * ne doit pas suivre.
   *
   * La cle porte le creneau ET l'exercice reel : un remplacement ne change pas
   * le creneau, et s'en tenir a lui laissait la charge saisie pour la barre
   * suivre sur la machine, ou elle ne veut pas dire la meme chose. Le creneau
   * reste dans la cle parce qu'un meme exercice peut figurer deux fois dans une
   * journee.
   *
   * Le garde-fou n'est pas cosmetique : l'effet se redeclenche a chaque serie
   * validee, et sans lui la deuxieme execution voyait « une serie deja faite »
   * et refermait la rampe apres le premier palier. Une memoire simple, hors
   * runes, rend l'operation idempotente quelle que soit la raison du reveil.
   */
  let openedFor: string | null = null;

  $effect(() => {
    const id = `${slot?.id ?? 0}:${exerciseId}`;
    if (openedFor === id) return;
    openedFor = id;

    untrack(() => {
      announced = [];
      enteredTarget = 0;
      skipped = false;
      warmupIndex = warmupOn && ramp.length > 0 && allToday.length === 0 ? 0 : null;
    });
  });

  // Les raccourcis de repetitions couvrent la fourchette prevue et un peu au-dela.
  const repChoices = $derived.by(() => {
    const from = Math.max(1, (slot?.rep_min ?? 8) - 1);
    return Array.from({ length: 6 }, (_, i) => from + i);
  });

  const increment = $derived(exercise?.increment_kg ?? 2.5);

  /**
   * Une charge externe est indispensable partout sauf au poids du corps, ou
   * zero signifie « sans lest » et reste une valeur legitime. Sans ce garde-fou,
   * le bouton du bas enregistrerait une serie a 0 kg.
   */
  const needsLoad = $derived(exercise !== undefined && exercise.equipment !== 'bodyweight');
  const missingLoad = $derived(needsLoad && weight <= 0);

  /** Disques a mettre de chaque cote, pour la charge affichee. */
  const perSide = $derived(
    exercise && exercise.equipment === 'barbell'
      ? loadable(weight, exercise, store.equipment).perSide
      : null,
  );

  // --- Echauffement guide ----------------------------------------------------
  //
  // La rampe est calculee sur la charge SUGGEREE, pas sur la valeur affichee :
  // celle-ci vaut le palier en cours pendant l'echauffement, et s'en servir
  // ferait tourner le calcul en rond.

  const ramp = $derived(
    warmupOn && exercise && slot && workTarget > 0
      ? warmupRamp(workTarget, exercise, store.equipment, slot.rest_seconds)
      : [],
  );


  /** Position dans la rampe. null : on est sur les series de travail. */
  let warmupIndex = $state<number | null>(null);
  /** Rampe ecartee volontairement : on ne la repropose pas sur cet exercice. */
  let skipped = $state(false);
  const step = $derived(warmupIndex === null ? null : ramp[warmupIndex] ?? null);
  /**
   * L'echelle reste a l'ecran tant qu'elle a un sens : pendant qu'on la gravit,
   * et tant qu'aucune serie de travail n'est consignee. L'echauffement est
   * l'etat normal de debut d'exercice, pas une proposition qui apparait.
   */
  const rampVisible = $derived(
    ramp.length > 0 && !skipped && (step !== null || doneToday.length === 0),
  );
  /** Echelle affichee mais pas encore entamee : il reste un tap a donner. */
  const rampPending = $derived(
    rampVisible && warmupIndex === null && warmupsToday.length === 0,
  );

  function skipWarmup() {
    warmupIndex = null;
    skipped = true;
  }

  function startRamp() {
    if (ramp.length > 0) warmupIndex = 0;
  }

  function focusWeight() {
    const input = document.querySelector<HTMLInputElement>('.value input');
    input?.focus();
    input?.select();
  }

  const allSlotsDone = $derived(
    slots.length > 0 && session !== null
      && slots.every((s) => {
        const actual = store.swapFor(session.id, s.exercise_id) ?? s.exercise_id;
        return workingSets(store.setsOfExercise(session.id, actual)).length >= s.target_sets;
      }),
  );

  // --- Supersets -------------------------------------------------------------
  // Les exercices d'un meme groupe s'enchainent sans repos : le minuteur
  // n'attend qu'apres le dernier du groupe.

  const groupSlots = $derived(
    slot?.superset_group == null ? [] : slots.filter((s) => s.superset_group === slot.superset_group),
  );
  const isSuperset = $derived(groupSlots.length > 1);
  const positionInGroup = $derived(isSuperset ? groupSlots.findIndex((s) => s.id === slot.id) : -1);
  const isLastOfGroup = $derived(!isSuperset || positionInGroup === groupSlots.length - 1);

  function bump(delta: number) {
    const raw = Math.max(0, weight + delta);
    weight = exercise ? loadable(raw, exercise, store.equipment).weightKg : Math.round(raw * 4) / 4;
    trackTarget();
  }

  /**
   * Retient la charge saisie comme charge de travail visee, tant que rien n'a
   * ete consigne. Appelee a chaque frappe : la rampe doit apparaitre pendant
   * qu'on tape, pas au moment ou l'on clique ailleurs.
   */
  function trackTarget() {
    if (step || allToday.length > 0) return;
    enteredTarget = weight;
  }

  function log(kind: SetKind, weightKg: number, repCount: number) {
    if (!session || !slot || !exercise) return;

    const sameKind = allToday.filter((s) => (s.kind === 'warmup') === (kind === 'warmup'));
    const result = store.logSet({
      sessionId: session.id,
      exerciseId,
      setIndex: sameKind.length + 1,
      weightKg,
      reps: repCount,
      kind,
      rpe: kind === 'warmup' ? null : rpe,
    });
    announced = result.records;

    void ensureNotifications();
    void restTimer.holdScreen();
    return result;
  }

  function validate() {
    if (!slot || !exercise) return;
    const current = step;
    log(current ? 'warmup' : 'work', weight, reps);

    if (current) {
      // Repos court entre deux paliers, allonge a mesure qu'on approche.
      restTimer.start(current.restSeconds, exercise.name);
      warmupIndex = warmupIndex! + 1 < ramp.length ? warmupIndex! + 1 : null;
      return;
    }

    // Un maillon de superset n'ouvre pas de repos : on enchaine.
    if (!isLastOfGroup) {
      goTo(index + 1);
      return;
    }
    restTimer.start(slot.rest_seconds, exercise.name);

    // Series prevues bouclees : on enchaine sur l'exercice suivant pendant le
    // repos. Le tableau de marque du suivant est ainsi deja sous les yeux, et
    // sa rampe d'echauffement s'ouvre si la charge la justifie.
    if (workingSets(allToday).length >= slot.target_sets) {
      const next = nextIncomplete(index);
      if (next !== null) goTo(next);
    }
  }

  function finish() {
    if (!session) return;
    restTimer.cancel();
    restTimer.releaseScreen();
    store.endSession(session.id);
    router.go(paths.home);
  }

  // --- Navigation entre exercices : onglets et glissement horizontal ---------

  let swipeFrom: { x: number; y: number } | null = null;

  function pointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse') return;
    swipeFrom = { x: event.clientX, y: event.clientY };
  }

  function pointerUp(event: PointerEvent) {
    if (!swipeFrom) return;
    const dx = event.clientX - swipeFrom.x;
    const dy = event.clientY - swipeFrom.y;
    swipeFrom = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    goTo(index + (dx < 0 ? 1 : -1));
  }

  /**
   * Prochain exercice dont les series prevues ne sont pas bouclees, en repartant
   * du debut si la fin est atteinte. null quand la seance est complete.
   */
  function nextIncomplete(from: number): number | null {
    if (!session) return null;
    for (let offset = 1; offset <= slots.length; offset++) {
      const candidate = (from + offset) % slots.length;
      const target = slots[candidate];
      const done = workingSets(store.setsOfExercise(session.id, target.exercise_id)).length;
      if (done < target.target_sets) return candidate;
    }
    return null;
  }

  function goTo(next: number) {
    index = Math.min(slots.length - 1, Math.max(0, next));
    document.getElementById(`tab-${index}`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  const EQUIPMENT_LABEL: Record<string, string> = {
    barbell: 'barre', dumbbell: 'haltères', machine: 'machine guidée',
    cable: 'poulie', bodyweight: 'poids du corps',
  };

  /** Derniere performance connue sur un remplacant, pour choisir en connaissance. */
  function lastOn(id: number): string {
    const previous = performanceHistory(store.sets, store.sessions, id, session?.id, 1)[0];
    if (!previous) return 'jamais fait';
    const top = previous.sets[0];
    return `${ago(previous.date)} · ${kg(top.weight_kg)} kg × ${top.reps}`;
  }

  const RECORD_LABEL: Record<DetectedRecord['kind'], string> = {
    weight: 'charge',
    e1rm: 'force estimée',
    set_volume: 'volume de série',
    session_volume: 'volume de séance',
  };

  const REASON_NOTE: Record<string, string> = {
    'double-increment': 'RPE bas la fois d’avant — deux incréments',
    increment: 'fourchette bouclée — charge augmentée',
    consolidate: 'RPE élevé la fois d’avant — on consolide',
    deload: 'stagnation — allègement proposé',
  };

  $effect(() => {
    if (!session) router.go(paths.home);
  });
</script>

{#if session && day && slot && exercise}
  <div class="workout">
    <header>
      <button class="back" onclick={() => router.go(paths.home)} aria-label="Retour à l'accueil">‹</button>
      <div class="grow stack">
        <span class="label">{day.name}</span>
        <span class="unit">
          {#if step}
            <!-- Pendant la rampe, le compteur d'exercices encombre : la bande
                 d'onglets le porte deja. -->
            échauffement {step.index}/{ramp.length}
          {:else}
            {doneToday.length ? `${doneToday.length}/${slot.target_sets} séries` : `série ${nextSetIndex}`}
            · exercice {index + 1}/{slots.length}
          {/if}
        </span>
      </div>
      <SyncBadge />
      <button
        class="btn btn-quiet note-toggle"
        class:on={noteOpen || !!noteDraft}
        onclick={() => (noteOpen = !noteOpen)}
        aria-pressed={noteOpen}
        aria-label="Note sur cet exercice"
      >note</button>
      <button class="btn btn-quiet finish" onclick={finish}>Terminer</button>
    </header>

    <nav class="tabs">
      {#each slots as s, i (s.id)}
        {@const actual = store.swapFor(session.id, s.exercise_id) ?? s.exercise_id}
        {@const name = store.exercise(actual)?.name ?? '—'}
        {@const count = workingSets(store.setsOfExercise(session.id, actual)).length}
        <button
          id="tab-{i}"
          class:current={i === index}
          class:complete={count >= s.target_sets}
          class:linked={s.superset_group != null}
          onclick={() => goTo(i)}
        >
          {#if s.superset_group != null}<span class="link" aria-hidden="true"></span>{/if}
          {name}
          <span class="tally">{count}/{s.target_sets}</span>
        </button>
      {/each}
    </nav>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="body" onpointerdown={pointerDown} onpointerup={pointerUp} onpointercancel={() => (swipeFrom = null)}>
      <div class="band title">
        <div class="title-row">
          <div class="grow stack">
            <h2>{exercise.name}</h2>
            <span class="unit">
              {scheme(slot.target_sets, slot.rep_min, slot.rep_max)} · repos {clock(slot.rest_seconds)}
              {#if isSuperset} · superset {positionInGroup + 1}/{groupSlots.length}{/if}
            </span>
            {#if swapped && planned}
              <span class="unit accent">à la place de {planned.name}</span>
            {/if}
          </div>
          {#if alternatives.length}
            <button class="btn btn-quiet swap" onclick={() => (choosing = !choosing)}>
              {choosing ? 'Annuler' : 'Remplacer'}
            </button>
          {/if}
        </div>

        <ExerciseDiagram key={exercise.diagram} label={exercise.name} />
      </div>

      {#if choosing}
        <!--
          Le remplacement ne touche que cette seance : la machine sera peut-etre
          libre la prochaine fois. Chaque option montre son schema et ce qu'on y
          a fait la derniere fois, pour choisir sans deviner.
        -->
        <section class="band chooser">
          <p class="label hint">La machine est prise ? Choisissez un remplaçant pour cette séance.</p>

          <ul class="options">
            {#if swapped && planned}
              <li>
                <button class="option" onclick={() => chooseAlternative(null)}>
                  <span class="thumb"><ExerciseDiagram key={planned.diagram} label={planned.name} height={40} /></span>
                  <span class="grow stack">
                    <span class="opt-name">Revenir à {planned.name}</span>
                    <span class="unit">l'exercice prévu</span>
                  </span>
                </button>
              </li>
            {/if}

            {#each alternatives as option (option.id)}
              <li>
                <button class="option" class:on={option.id === exerciseId} onclick={() => chooseAlternative(option.id)}>
                  <span class="thumb"><ExerciseDiagram key={option.diagram} label={option.name} height={40} /></span>
                  <span class="grow stack">
                    <span class="opt-name">{option.name}</span>
                    <span class="unit">{EQUIPMENT_LABEL[option.equipment] ?? option.equipment} · {lastOn(option.id)}</span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {:else}
      {#if announced.length}
        <div class="band records">
          {#each announced as record (record.kind)}
            <p class="record">
              <span class="dot"></span>
              Record de {RECORD_LABEL[record.kind]} —
              <span class="num">{kg(Math.round(record.value * 10) / 10)}</span>
              {#if record.previous !== null}<span class="unit">avant {kg(Math.round(record.previous * 10) / 10)}</span>{/if}
            </p>
          {/each}
        </div>
      {/if}

      <!--
        Le tableau de marque. Les deux blocs partagent exactement la meme grille :
        la progression se lit comme une difference verticale, colonne par colonne,
        sans avoir a relire chaque ligne. C'est la donnee la plus consultee de
        l'application (section 5.2), elle est donc composee plus grand que les
        champs de saisie.
      -->
      <section class="band">
        <div class="eyebrow">
          <span class="label">La fois d'avant</span>
          <span class="label">{previous ? ago(previous.date) : 'jamais fait'}</span>
        </div>

        {#if previous}
          {#each previous.sets as entry (entry.id)}
            <div class="line past">
              <span class="idx num">{entry.set_index}</span>
              <span class="cell"><span class="load num">{kg(entry.weight_kg)}</span><span class="unit">kg</span></span>
              <span class="cell">
                <span class="reps num">{entry.reps}</span><span class="unit">reps</span>
                {#if entry.rpe !== null}<span class="unit rpe">RPE {entry.rpe}</span>{/if}
              </span>
              <span></span>
            </div>
          {/each}
        {:else}
          <p class="label">
            Première fois sur cet exercice. Entrez la charge de travail : l'échauffement
            sera calculé à partir d'elle.
          </p>
        {/if}

        {#if lastNote}
          <p class="note-past">«&nbsp;{lastNote.note}&nbsp;»</p>
        {/if}
      </section>

      <section class="band">
        <div class="eyebrow">
          <span class="label accent">Aujourd'hui</span>
          {#if suggestion && REASON_NOTE[suggestion.reason]}
            <span class="label" class:accent={suggestion.incremented}>{REASON_NOTE[suggestion.reason]}</span>
          {/if}
        </div>

        {#if noteOpen}
          <textarea
            class="field note-field"
            rows="2"
            placeholder="Ce qu'il faudra se rappeler la prochaine fois."
            bind:value={noteDraft}
            onblur={() => session && slot && store.setExerciseNote(exerciseId, session.id, noteDraft)}
          ></textarea>
        {:else if noteDraft}
          <button class="note-current" onclick={() => (noteOpen = true)}>«&nbsp;{noteDraft}&nbsp;»</button>
        {/if}

        {#if rampVisible}
          <!--
            L'echelle. Chaque barreau porte son etat : franchi, en cours, a
            venir. C'est la difference entre proposer un echauffement et le
            conduire — on voit d'ou l'on part, ou l'on en est, et ce qu'il reste
            avant la premiere serie de travail.
          -->
          <section class="ramp">
            <div class="ramp-head">
              <span class="label accent">Échauffement</span>
              <span class="label grow">
                {step ? `palier ${step.index} sur ${ramp.length}` : `${ramp.length} paliers`}
              </span>
              <button class="skip" onclick={skipWarmup}>Passer</button>
            </div>

            <ol class="rail">
              {#each ramp as level (level.index)}
                {@const done = warmupsToday.length >= level.index}
                {@const current = step?.index === level.index}
                <li class="rung" class:done class:current class:idle={rampPending}>
                  <span class="mark" aria-hidden="true"></span>
                  <span class="cell">
                    <span class="load num">{kg(level.weightKg)}</span>
                    <span class="unit">kg</span>
                    {#if level.bar}<span class="unit">barre</span>{/if}
                  </span>
                  <span class="cell"><span class="reps num">{level.reps}</span><span class="unit">reps</span></span>
                  <span class="unit rest">{clock(level.restSeconds)}</span>
                </li>
              {/each}
            </ol>
          </section>
        {:else if warmupsToday.length}
          <!-- L'echauffement fait tient sur une ligne : c'est un repere, pas
               une donnee, et la place gagnee revient a la serie a venir. -->
          <div class="warmline">
            <span class="unit">échauffement</span>
            <span class="grow">
              {#each warmupsToday as entry (entry.id)}
                <span class="num warmval">{kg(entry.weight_kg)}<span class="unit">×{entry.reps}</span></span>
              {/each}
            </span>
            <button
              class="drop"
              onclick={() => store.removeSet(warmupsToday[warmupsToday.length - 1].id)}
              aria-label="Supprimer le dernier échauffement"
            >✕</button>
          </div>
        {/if}

        {#if !step}
          {#each doneToday as entry (entry.id)}
            <div class="line">
              <span class="idx num">{entry.set_index}</span>
              <span class="cell"><span class="load num">{kg(entry.weight_kg)}</span><span class="unit">kg</span></span>
              <span class="cell">
                <span class="reps num">{entry.reps}</span><span class="unit">reps</span>
                {#if entry.rpe !== null}<span class="unit rpe">RPE {entry.rpe}</span>{/if}
              </span>
              <button class="drop" onclick={() => store.removeSet(entry.id)} aria-label="Supprimer la série {entry.set_index}">✕</button>
            </div>
          {/each}

          <div class="line pendingline">
            <span class="idx num">{nextSetIndex}</span>
            <span class="cell"><span class="load num">{kg(weight)}</span><span class="unit">kg</span></span>
            <span class="cell"><span class="reps num">{reps}</span><span class="unit">reps</span></span>
            <span></span>
          </div>
        {/if}
      </section>

      {/if}

      {#if allSlotsDone}
        <div class="band">
          <p class="label">Toutes les séries du programme sont faites. Vous pouvez terminer la séance.</p>
        </div>
      {/if}
    </div>

    <!-- Bloc ancre : tout ce qui se touche entre deux series tient dans le
         tiers inferieur de l'ecran (section 8). -->
    <div class="anchor">
      <div class="controls">
        <div class="weight">
          <button class="adjust" onclick={() => bump(-increment)} aria-label="Retirer {kg(increment)} kilos">−{kg(increment)}</button>
          <label class="value">
            <span class="sr">Charge en kilos</span>
            <input
              class="num" type="number" inputmode="decimal" step={increment} min="0"
              bind:value={weight}
              oninput={trackTarget}
            />
            <span class="unit">kg</span>
          </label>
          <button class="adjust" onclick={() => bump(increment)} aria-label="Ajouter {kg(increment)} kilos">+{kg(increment)}</button>
        </div>

        {#if perSide}<Plates {perSide} bar={exercise.bar_kg ?? 20} />{/if}

        <div class="reps-row" role="group" aria-label="Répétitions">
          {#each repChoices as choice (choice)}
            <button class="rep num" class:on={reps === choice} onclick={() => (reps = choice)}>{choice}</button>
          {/each}
        </div>

        {#if rpeOn && !step}
          <div class="rpe-row" role="group" aria-label="Effort perçu">
            <span class="unit rpe-label">RPE</span>
            {#each [6, 7, 8, 9, 10] as value (value)}
              <button class="rep num" class:on={rpe === value} onclick={() => (rpe = rpe === value ? null : value)}>{value}</button>
            {/each}
          </div>
        {/if}
      </div>

      <RestTimer restSeconds={slot.rest_seconds} />

      <!-- L'action principale dit toujours ce qui doit arriver ensuite. -->
      {#if missingLoad}
        <!-- Rien a valider tant que la charge est inconnue : le bouton le dit
             et renvoie au champ plutot que d'enregistrer une serie a vide. -->
        <button class="btn btn-xl btn-block validate prompt" onclick={focusWeight}>
          Entrez la charge de travail
        </button>
      {:else if rampPending}
        <button class="btn btn-xl btn-block validate" onclick={startRamp}>
          Commencer l'échauffement · {ramp.length} palier{ramp.length > 1 ? 's' : ''}
        </button>
      {:else}
        <button class="btn btn-xl btn-block validate" class:btn-accent={!step} class:warm={step} onclick={validate}>
          {#if step}
            Valider le palier {step.index}/{ramp.length}
          {:else if isSuperset && !isLastOfGroup}
            Valider — enchaîner
          {:else}
            Valider la série {nextSetIndex}
          {/if}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .workout {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }

  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: calc(env(safe-area-inset-top, 0px) + 8px) 10px 8px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }

  .back {
    width: var(--tap);
    height: var(--tap);
    font-size: 1.75rem;
    line-height: 1;
    color: var(--ink-dim);
    flex: none;
  }

  .finish, .note-toggle {
    min-height: 40px;
    padding: 0 12px;
    font-size: 0.8125rem;
  }
  .note-toggle.on { color: var(--ink); border-color: var(--line-strong); }

  /* Ce qu'on s'etait dit la fois d'avant, a cote de ce qu'on avait fait. */
  .note-past {
    margin-top: 10px;
    font-size: 0.875rem;
    line-height: 1.45;
    color: var(--ink-dim);
  }

  .note-current {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 0;
    font-size: 0.875rem;
    color: var(--ink-dim);
  }

  .note-field {
    min-height: 62px;
    padding: 8px 10px;
    margin-bottom: 8px;
    line-height: 1.45;
    resize: vertical;
  }

  /* Bandeau d'onglets : l'avancement de chaque exercice est visible sans
     changer d'ecran. */
  .tabs {
    display: flex;
    gap: 0;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .tabs::-webkit-scrollbar { display: none; }

  .tabs button {
    display: flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
    padding: 0 14px;
    height: 44px;
    font-size: 0.8125rem;
    font-weight: 550;
    color: var(--ink-faint);
    border-bottom: 2px solid transparent;
  }
  .tabs button.current { color: var(--ink); border-bottom-color: var(--accent); }
  .tabs button.complete .tally { color: var(--accent); }

  /* Marqueur de superset dessine plutot qu'ecrit : aucun glyphe de la fonte
     systeme ne dit « enchaine » de facon fiable. */
  .link {
    width: 2px;
    height: 16px;
    background: var(--line-strong);
    flex: none;
  }
  .tabs button.current .link { background: var(--accent); }

  .tally {
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--ink-faint);
  }

  .body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    /* La ligne a venir ne doit jamais coller au bord du bloc ancre. */
    padding-bottom: 10px;
    scroll-padding-bottom: 10px;
  }

  .title { padding-bottom: 14px; }
  .title h2 { font-size: 1.5rem; margin-bottom: 2px; }

  .title-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 10px;
  }
  .swap {
    min-height: 40px;
    padding: 0 12px;
    font-size: 0.8125rem;
    flex: none;
  }

  /* --- Choix d'un remplacant --- */

  .chooser .hint { margin-bottom: 12px; }
  .options { list-style: none; margin: 0; padding: 0; }

  .option {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    text-align: left;
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  .option.on { color: var(--accent); }
  .opt-name { font-size: 0.9375rem; font-weight: 550; }

  .thumb {
    width: 72px;
    flex: none;
    border: 1px solid var(--line);
    border-radius: 2px;
    background: var(--surface);
    padding: 2px;
  }

  /* Un record est annonce, pas celebre : ni modale, ni confettis. */
  .records { padding-top: 12px; padding-bottom: 12px; }
  .record {
    display: flex;
    align-items: baseline;
    gap: 7px;
    font-size: 0.875rem;
    color: var(--accent);
  }
  .record .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
    align-self: center;
  }
  .record .unit { color: var(--ink-faint); }

  /* La grille partagee par les deux blocs du tableau de marque : les colonnes
     sont identiques au-dessus et en dessous, c'est ce qui permet de lire la
     progression verticalement. */
  .line {
    display: grid;
    grid-template-columns: 34px 1fr 1fr 44px;
    align-items: baseline;
    gap: 0 8px;
    padding: 3px 0;
  }

  .cell {
    display: flex;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
  }

  .idx {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--ink-faint);
  }

  .load, .reps {
    font-size: clamp(1.375rem, 5.5vw, 1.875rem);
    line-height: 1.18;
  }

  .past .load, .past .reps { color: var(--ink-dim); }
  .past .idx { color: var(--ink-faint); }

  /* Un echauffement s'efface : il ne compte dans aucune statistique. */
  .warmline {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 4px 0 8px;
    color: var(--ink-faint);
  }
  .warmline .grow { display: flex; gap: 12px; flex-wrap: wrap; }
  .warmval { font-size: 1.0625rem; color: var(--ink-dim); }
  .warmval .unit { margin-left: 2px; }

  .rpe { color: var(--ink-faint); margin-left: 4px; }

  /* La serie a venir : meme grille, valeurs en accent, pour lire d'un coup
     l'ecart avec la ligne du dessus. */
  .pendingline .load, .pendingline .reps { color: var(--accent); }
  .pendingline .idx { color: var(--accent-dim); }

  .drop {
    width: 44px;
    height: 40px;
    margin: -8px 0;
    color: var(--ink-faint);
    font-size: 0.875rem;
    justify-self: end;
  }

  /* --- L'echelle d'echauffement --- */

  .ramp { margin-bottom: 4px; }

  .ramp-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .skip {
    min-height: 40px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 0.8125rem;
    font-weight: 550;
    color: var(--ink-dim);
    flex: none;
  }

  .rail { list-style: none; margin: 0; padding: 0; }

  .rung {
    position: relative;
    display: grid;
    grid-template-columns: 24px 1fr 1fr auto;
    align-items: center;
    gap: 0 8px;
    padding: 7px 0;
  }

  /* Le montant qui relie les barreaux : il se colore jusqu'ou l'on est monte. */
  .rung:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 50%;
    height: 100%;
    width: 1px;
    background: var(--line-strong);
  }
  .rung.done:not(:last-child)::before { background: var(--accent-dim); }

  .mark {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    background: var(--bg);
    justify-self: start;
    position: relative;
    z-index: 1;
  }
  .rung.done .mark { background: var(--accent); border-color: var(--accent); }
  .rung.current .mark {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
  }

  .rung .load, .rung .reps { font-size: 1.375rem; line-height: 1.1; }
  .rung, .rung .unit { color: var(--ink-faint); }
  .rung.done .load, .rung.done .reps { color: var(--ink-dim); }
  .rung.current .load, .rung.current .reps { color: var(--accent); }
  .rung.current .unit { color: var(--ink-dim); }

  .rest { justify-self: end; font-variant-numeric: tabular-nums; }

  .anchor {
    flex: none;
    border-top: 1px solid var(--line);
    padding-bottom: var(--bottom-safe);
    background: var(--bg);
  }

  .controls { padding: 12px var(--gutter) 10px; }

  .weight {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }

  .adjust {
    min-width: 74px;
    height: 56px;
    border: 1px solid var(--line-strong);
    border-radius: 2px;
    font-size: 0.9375rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
    background: var(--surface);
  }

  .value {
    flex: 1;
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 5px;
    height: 56px;
    border: 1px solid var(--line);
    border-radius: 2px;
    background: var(--surface);
    padding: 0 6px;
  }

  .value input {
    width: 100%;
    text-align: right;
    font-size: 1.875rem;
    font-weight: 650;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
    background: none;
    align-self: center;
  }
  .value input:focus { outline: none; }

  .reps-row {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  .rpe-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .rpe-row .rep { height: 44px; font-size: 1rem; }

  .rep {
    flex: 1;
    height: 52px;
    border: 1px solid var(--line);
    border-radius: 2px;
    background: var(--surface);
    font-size: 1.125rem;
    color: var(--ink-dim);
  }

  .rep.on {
    border-color: var(--accent);
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  }

  .rpe-label {
    width: 60px;
    flex: none;
    align-self: center;
    text-align: center;
  }

  .validate {
    border-radius: 0;
    border-left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  /* Ni accent ni validation : il manque une information pour agir. */
  .validate.prompt {
    background: var(--surface-high);
    border-top: 1px solid var(--line-strong);
    color: var(--ink-dim);
  }

  /* L'accent est reserve a la validation d'une vraie serie de travail. */
  .validate.warm {
    background: var(--surface-high);
    border-top: 1px solid var(--line-strong);
    color: var(--ink);
  }

  /* Bureau : l'ecran de seance reste une colonne. Sa disposition est dictee
     par le pouce, pas par la place disponible — l'etirer sur 1600 px eloignerait
     le tableau de marque des champs de saisie sans rien apporter. On l'encadre
     pour que ce soit un choix visible et non un oubli. */
  @media (min-width: 860px) {
    .workout {
      max-width: 620px;
      margin: 0 auto;
      border-left: 1px solid var(--line);
      border-right: 1px solid var(--line);
    }
  }

  @media (hover: hover) {
    .tabs button:hover { color: var(--ink); }
    .rep:not(.on):hover { border-color: var(--line-strong); }
    .adjust:hover { border-color: var(--ink-faint); }
    .drop:hover { color: var(--red); }
    .skip:hover { color: var(--ink); border-color: var(--line-strong); }
  }

  .sr {
    position: absolute;
    width: 1px; height: 1px;
    padding: 0; margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
