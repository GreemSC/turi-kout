<script lang="ts">
  import { store } from './lib/store.svelte.ts';
  import { router, paths } from './lib/router.svelte.ts';
  import { restTimer } from './lib/timer.svelte.ts';
  import Nav from './lib/Nav.svelte';
  import UpdateBar from './lib/UpdateBar.svelte';

  import Login from './screens/Login.svelte';
  import Home from './screens/Home.svelte';
  import Workout from './screens/Workout.svelte';
  import History from './screens/History.svelte';
  import SessionDetail from './screens/SessionDetail.svelte';
  import Progress from './screens/Progress.svelte';
  import Program from './screens/Program.svelte';
  import Settings from './screens/Settings.svelte';

  let booted = $state(false);

  $effect(() => {
    void store.boot().then(() => {
      booted = true;
      // Section 6 : la seance en cours est l'ecran par defaut quand il y en a une.
      if (store.openSession && !location.hash) router.go(paths.workout);
      void store.prune();
    });

    const onVisible = () => restTimer.reacquireScreen();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  const route = $derived(router.current);
  const showNav = $derived(route.name !== 'workout');
</script>

{#if !booted}
  <div class="boot"><span class="label">Chargement…</span></div>
{:else if !store.authed}
  <Login />
{:else}
  <div class="shell" class:with-nav={showNav}>
    {#if showNav}<Nav />{/if}
    <main>
      {#if route.name === 'home'}
        <Home />
      {:else if route.name === 'workout'}
        <Workout />
      {:else if route.name === 'history'}
        <History />
      {:else if route.name === 'session'}
        <SessionDetail id={route.id} />
      {:else if route.name === 'progress'}
        <Progress />
      {:else if route.name === 'program'}
        <Program />
      {:else if route.name === 'settings'}
        <Settings />
      {/if}
    </main>
    <!-- Pas pendant une seance : rien ne doit s'interposer entre deux series. -->
    {#if showNav}<UpdateBar />{/if}
  </div>
{/if}

<style>
  .boot {
    min-height: 100dvh;
    display: grid;
    place-items: center;
  }

  /* Telephone : la navigation est ancree en bas, le contenu lui laisse la place. */
  .shell.with-nav main {
    padding-bottom: calc(var(--tap) + 8px + var(--bottom-safe));
  }

  /* Bureau : la navigation passe sur le cote, le contenu reprend toute la
     hauteur et cesse de s'etirer sur la largeur de l'ecran. */
  @media (min-width: 860px) {
    .shell.with-nav main {
      padding-bottom: 48px;
      padding-left: var(--rail);
    }
  }
</style>
