<script lang="ts">
  // Ce qu'il faut charger de chaque cote. C'est le calcul qu'on fait vraiment
  // devant la barre, entre deux series, et le seul endroit de l'application ou
  // la couleur porte une information : ce sont les teintes normalisees des
  // disques de competition, celles qu'on a sous les yeux dans la salle.
  import { kg } from './format.ts';

  let { perSide, bar }: { perSide: number[]; bar: number } = $props();

  const COLOURS: Record<number, string> = {
    25: '#c8102e',   // rouge
    20: '#0057b8',   // bleu
    15: '#f5b301',   // jaune — la teinte d'accent de l'application
    10: '#009639',   // vert
    5: '#e8e6e1',    // blanc
    2.5: '#c8102e',  // rouge
    1.25: '#a8a8a8', // chrome
    0.5: '#8f8f8f',
  };

  const colour = (weight: number) => COLOURS[weight] ?? '#6b6b6b';
  /** Hauteur proportionnelle a la charge, plafonnee : un 20 doit dominer un 1,25. */
  const height = (weight: number) => Math.round(10 + Math.min(1, weight / 20) * 12);

  const total = $derived(bar + perSide.reduce((sum, p) => sum + p, 0) * 2);
</script>

<div class="plates" aria-label={perSide.length
  ? `${perSide.map((p) => kg(p)).join(', ')} kilos de chaque côté`
  : 'barre à vide'}>
  <span class="bar" aria-hidden="true"></span>

  {#if perSide.length}
    {#each perSide as plate, i (`${plate}-${i}`)}
      <span class="plate" style:background={colour(plate)} style:height="{height(plate)}px" aria-hidden="true"></span>
    {/each}
    <span class="unit">{perSide.map((p) => kg(p)).join(' · ')} par côté</span>
  {:else}
    <span class="unit">barre à vide — {kg(total)} kg</span>
  {/if}
</div>

<style>
  .plates {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 26px;
    margin-top: 8px;
  }

  .bar {
    width: 14px;
    height: 3px;
    background: var(--line-strong);
    flex: none;
  }

  .plate {
    width: 5px;
    border-radius: 1px;
    flex: none;
  }

  .unit { margin-left: 8px; }
</style>
