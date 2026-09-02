<script lang="ts">
  // Un seul champ : le jeton defini par variable d'environnement. Pas de compte,
  // pas de mot de passe oublie, pas d'expiration (section 2).
  import { store } from '../lib/store.svelte.ts';

  let token = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    busy = true;
    error = '';
    try {
      await store.signIn(token.trim());
    } catch {
      error = 'Jeton refusé. Vérifiez AUTH_TOKEN sur le serveur.';
      busy = false;
    }
  }
</script>

<div class="wrap">
  <div class="mark" aria-hidden="true"></div>
  <h1>Turi Kout</h1>
  <p class="label">Entrez le jeton d'accès. Il reste valide sur cet appareil.</p>

  <form onsubmit={submit}>
    <input
      class="field"
      type="password"
      autocomplete="current-password"
      placeholder="Jeton d'accès"
      bind:value={token}
      aria-label="Jeton d'accès"
      aria-invalid={error ? 'true' : undefined}
    />
    {#if error}<p class="label danger">{error}</p>{/if}
    <button class="btn btn-accent btn-block" type="submit" disabled={busy || !token.trim()}>
      {busy ? 'Vérification…' : 'Ouvrir'}
    </button>
  </form>
</div>

<style>
  .wrap {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
    padding: 0 var(--gutter);
    max-width: 420px;
    margin: 0 auto;
  }

  /* Rappel de l'icone : une barre et ses disques, en filets. */
  .mark {
    width: 96px;
    height: 34px;
    margin-bottom: 12px;
    background:
      linear-gradient(var(--accent), var(--accent)) 0 50% / 8px 100% no-repeat,
      linear-gradient(var(--accent), var(--accent)) 14px 50% / 5px 62% no-repeat,
      linear-gradient(var(--accent), var(--accent)) 0 50% / 100% 6px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 77px 50% / 5px 62% no-repeat,
      linear-gradient(var(--accent), var(--accent)) 88px 50% / 8px 100% no-repeat;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 16px;
  }
</style>
