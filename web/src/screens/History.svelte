<script lang="ts">
  import { store } from '../lib/store.svelte.ts';
  import { paths } from '../lib/router.svelte.ts';
  import { workVolume } from '../../../shared/domain.ts';
  import { dayLabel, duration, timeLabel } from '../lib/format.ts';
  import Header from '../lib/Header.svelte';

  const sessions = $derived(
    [...store.sessions].sort((a, b) => b.started_at.localeCompare(a.started_at)),
  );
</script>

<Header title="Historique" sub="90 derniers jours" />

<div class="screen">
  {#if sessions.length === 0}
    <p class="empty">Aucune séance enregistrée. Démarrez-en une depuis l'accueil.</p>
  {:else}
    <ul>
      {#each sessions as session (session.id)}
        {@const sets = store.setsOf(session.id)}
        {@const volume = Math.round(workVolume(sets, store.resolveLoad))}
        <li>
          <a href={paths.session(session.id)}>
            <div class="grow stack">
              <span class="name">
                {store.routineDay(session.routine_day_id)?.name ?? 'Séance'}
                {#if !session.ended_at}<span class="accent ongoing">en cours</span>{/if}
              </span>
              <span class="label">
                {dayLabel(session.started_at)} · {timeLabel(session.started_at)}
                {#if session.ended_at} · {duration(session.started_at, session.ended_at)}{/if}
              </span>
            </div>
            <div class="stack figures">
              <span class="num num-m">{sets.length}</span>
              <span class="unit">séries</span>
            </div>
            <div class="stack figures">
              <span class="num num-m">{volume.toLocaleString('fr-FR')}</span>
              <span class="unit">kg soulevés</span>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  ul { list-style: none; margin: 0; padding: 0; }

  /* Une liste ne gagne rien a s'etirer : on lui garde une mesure lisible. */
  @media (min-width: 860px) {
    ul { max-width: 820px; }
    a { min-height: 76px; }
  }

  @media (hover: hover) {
    a:hover { background: var(--surface); }
  }

  a {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px var(--gutter);
    border-bottom: 1px solid var(--line);
    color: inherit;
    text-decoration: none;
    min-height: 68px;
  }

  .name { font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.02em; }
  .ongoing { font-size: 0.6875rem; font-weight: 550; margin-left: 6px; }

  .figures { align-items: flex-end; text-align: right; flex: none; }
</style>
