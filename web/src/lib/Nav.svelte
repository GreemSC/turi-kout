<script lang="ts">
  // Telephone : barre d'onglets ancree en bas, pour rester dans le tiers
  // inferieur de l'ecran (section 8).
  // Bureau : la meme liste bascule en colonne laterale. Une barre d'onglets
  // etiree sur toute la largeur d'un ecran d'ordinateur n'a pas de sens, et la
  // contrainte du pouce ne s'y applique pas.
  // Libelles en toutes lettres plutot qu'icones — un pictogramme de barre et un
  // d'halteres ne se distinguent pas d'un coup d'oeil.
  import { router, paths } from './router.svelte.ts';
  import SyncBadge from './SyncBadge.svelte';

  const tabs = [
    { name: 'home', label: 'Accueil', href: paths.home },
    { name: 'history', label: 'Historique', href: paths.history },
    { name: 'progress', label: 'Progression', href: paths.progress },
    { name: 'program', label: 'Programme', href: paths.program },
    { name: 'settings', label: 'Réglages', href: paths.settings },
  ] as const;

  const active = $derived(router.current.name === 'session' ? 'history' : router.current.name);
</script>

<nav>
  <a class="mark" href={paths.home} aria-label="Accueil"><span aria-hidden="true"></span></a>

  <div class="tabs">
    {#each tabs as tab (tab.name)}
      <a href={tab.href} class:current={active === tab.name} aria-current={active === tab.name ? 'page' : undefined}>
        {tab.label}
      </a>
    {/each}
  </div>

  <div class="foot"><SyncBadge /></div>
</nav>

<style>
  nav {
    position: fixed;
    inset: auto 0 0 0;
    background: var(--bg);
    border-top: 1px solid var(--line);
    padding-bottom: var(--bottom-safe);
    z-index: 20;
  }

  .tabs {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
  }

  .tabs a {
    min-height: var(--tap);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px 2px;
    font-size: 0.6875rem;
    font-weight: 550;
    color: var(--ink-faint);
    text-decoration: none;
    text-align: center;
    border-top: 2px solid transparent;
    margin-top: -1px;
  }

  .tabs a.current {
    color: var(--ink);
    border-top-color: var(--accent);
  }

  /* La marque et l'indicateur de synchronisation n'ont pas leur place dans une
     barre d'onglets de telephone : ils n'apparaissent qu'en colonne. */
  .mark, .foot { display: none; }

  @media (min-width: 860px) {
    nav {
      inset: 0 auto 0 0;
      width: var(--rail);
      display: flex;
      flex-direction: column;
      border-top: 0;
      border-right: 1px solid var(--line);
      padding: 24px 0 20px;
    }

    .mark {
      display: block;
      padding: 0 20px 28px;
    }
    /* Rappel de l'icone : une barre et ses disques, en aplats. */
    .mark span {
      display: block;
      width: 62px;
      height: 22px;
      background:
        linear-gradient(var(--accent), var(--accent)) 0 50% / 5px 100% no-repeat,
        linear-gradient(var(--accent), var(--accent)) 9px 50% / 3px 62% no-repeat,
        linear-gradient(var(--accent), var(--accent)) 0 50% / 100% 4px no-repeat,
        linear-gradient(var(--accent), var(--accent)) 50px 50% / 3px 62% no-repeat,
        linear-gradient(var(--accent), var(--accent)) 57px 50% / 5px 100% no-repeat;
    }

    .tabs {
      display: flex;
      flex-direction: column;
      flex: 1;
    }

    .tabs a {
      justify-content: flex-start;
      min-height: 42px;
      padding: 0 20px;
      font-size: 0.875rem;
      text-align: left;
      border-top: 0;
      border-left: 2px solid transparent;
      margin-top: 0;
    }

    .tabs a.current {
      border-top-color: transparent;
      border-left-color: var(--accent);
      background: var(--surface);
    }

    /* Pas de filet ici : l'indicateur ne rend rien quand tout est synchronise,
       un cadre vide resterait affiche pour rien. */
    .foot {
      display: block;
      padding: 12px 20px 0;
    }
  }

  @media (min-width: 860px) and (hover: hover) {
    .tabs a:hover { color: var(--ink); }
  }
</style>
