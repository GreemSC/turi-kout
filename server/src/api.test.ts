import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'jeton-de-test-suffisamment-long';
const dir = mkdtempSync(join(tmpdir(), 'turi-kout-'));

process.env.NODE_ENV = 'test';
process.env.AUTH_TOKEN = TOKEN;
process.env.DB_PATH = join(dir, 'test.sqlite');
process.env.PUBLIC_DIR = join(dir, 'absent');

let app: FastifyInstance;
let cookie = '';

const auth = () => ({ cookie });

// Les fenetres du serveur (90 j d'historique, 30 j de nutrition) sont relatives
// a maintenant : les jeux de donnees de test doivent l'etre aussi.
const isoDaysAgo = (days: number, minutes = 0) =>
  new Date(Date.now() - days * 86_400_000 + minutes * 60_000).toISOString();
const dateDaysAgo = (days: number) => isoDaysAgo(days).slice(0, 10);

before(async () => {
  const { buildApp } = await import('./app.ts');
  app = await buildApp();

  const res = await app.inject({ method: 'POST', url: '/api/auth', payload: { token: TOKEN } });
  assert.equal(res.statusCode, 200);
  cookie = res.headers['set-cookie']!.toString().split(';')[0];
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('authentification', () => {
  test('les routes /api refusent une requete sans cookie', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/bootstrap' })).statusCode, 401);
  });

  test('un mauvais jeton est refuse', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth', payload: { token: 'mauvais' } });
    assert.equal(res.statusCode, 401);
  });

  test('le cookie est HttpOnly et de longue duree', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth', payload: { token: TOKEN } });
    const header = res.headers['set-cookie']!.toString();
    assert.match(header, /HttpOnly/i);
    assert.match(header, /Max-Age=315360000/i);
  });
});

describe('seed initial (section 9)', () => {
  test('le programme des quatre journees est charge', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() });
    assert.equal(res.statusCode, 200);
    const data = res.json();

    assert.deepEqual(data.routineDays.map((d: any) => d.name), ['Haut A', 'Bas A', 'Haut B', 'Bas B']);
    assert.equal(data.routineExercises.length, 22);
    // Le catalogue s'etend au materiel de salle : le programme, lui, ne bouge pas.
    assert.equal(data.exercises.length, 42);
    assert.ok(data.exercises.every((e: any) => e.diagram), 'chaque exercice a un schema');

    const bench = data.exercises.find((e: any) => e.name === 'Développé couché');
    const squat = data.exercises.find((e: any) => e.name === 'Squat');
    assert.equal(bench.increment_kg, 2.5, 'haut du corps : 2,5 kg');
    assert.equal(squat.increment_kg, 5, 'bas du corps : 5 kg');

    const benchSlot = data.routineExercises.find((r: any) => r.exercise_id === bench.id);
    assert.equal(benchSlot.rest_seconds, 120, '6-8 repetitions : 120 s');
    const curl = data.exercises.find((e: any) => e.name === 'Curl biceps');
    assert.equal(data.routineExercises.find((r: any) => r.exercise_id === curl.id).rest_seconds, 90);
  });
});

describe('idempotence des ecritures (section 3.4, critere 1)', () => {
  const sessionId = randomUUID();
  const startedAt = isoDaysAgo(2);
  const setIds = Array.from({ length: 12 }, () => randomUUID());

  test('creer deux fois la meme seance ne cree qu une ligne', async () => {
    const payload = { id: sessionId, routine_day_id: 1, started_at: startedAt };
    for (const _ of [1, 2]) {
      const res = await app.inject({ method: 'POST', url: '/api/sessions', headers: auth(), payload });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().id, sessionId);
    }
    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    assert.equal(data.sessions.filter((s: any) => s.id === sessionId).length, 1);
  });

  test('un lot de synchronisation rejoue deux fois ne duplique aucune serie', async () => {
    // Une seance entiere loggee hors ligne : 12 series (critere d'acceptation 1).
    const ops = setIds.map((id, i) => ({
      opId: randomUUID(),
      type: 'set.create' as const,
      payload: {
        id,
        session_id: sessionId,
        exercise_id: 1,
        set_index: (i % 4) + 1,
        weight_kg: 80,
        reps: 8,
        done_at: isoDaysAgo(2, i * 4),
      },
    }));

    for (const _ of [1, 2]) {
      const res = await app.inject({ method: 'POST', url: '/api/sync', headers: auth(), payload: { ops } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().applied.length, 12);
      assert.deepEqual(res.json().failed, []);
    }

    const history = (await app.inject({
      method: 'GET', url: '/api/exercises/1/history?limit=5', headers: auth(),
    })).json();
    assert.equal(history.length, 12, 'aucun doublon apres deux envois');

    // Les series remontent bien dans la fenetre d'historique du bootstrap.
    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    assert.equal(data.sets.filter((s: any) => s.session_id === sessionId).length, 12);
  });

  test('une operation invalide n empeche pas le reste du lot', async () => {
    const okA = randomUUID();
    const okB = randomUUID();
    const ko = randomUUID();
    const ops = [
      { opId: okA, type: 'bodyweight.upsert', payload: { measured_on: dateDaysAgo(9), weight_kg: 78.4 } },
      { opId: ko, type: 'set.create', payload: { id: randomUUID(), session_id: randomUUID(), exercise_id: 1, set_index: 1, weight_kg: 50, reps: 5, done_at: isoDaysAgo(2) } },
      { opId: okB, type: 'bodyweight.upsert', payload: { measured_on: dateDaysAgo(8), weight_kg: 78.6 } },
    ];
    const res = (await app.inject({ method: 'POST', url: '/api/sync', headers: auth(), payload: { ops } })).json();
    assert.deepEqual(res.applied, [okA, okB]);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].opId, ko);
  });

  test('supprimer deux fois la meme serie renvoie 200', async () => {
    const url = `/api/sets/${setIds[0]}`;
    assert.equal((await app.inject({ method: 'DELETE', url, headers: auth() })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url, headers: auth() })).statusCode, 200);
  });
});

describe('poids corporel', () => {
  test('une seule mesure par jour, la derniere ecrase la precedente', async () => {
    for (const w of [80, 80.4]) {
      const res = await app.inject({ method: 'PUT', url: `/api/bodyweight/${dateDaysAgo(3)}`, headers: auth(), payload: { weight_kg: w } });
      assert.equal(res.statusCode, 200);
    }
    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    const rows = data.bodyweights.filter((b: any) => b.measured_on === dateDaysAgo(3));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].weight_kg, 80.4);
  });

  test('les statistiques renvoient points bruts et moyenne glissante', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats/bodyweight?days=90', headers: auth() });
    const { series, trend } = res.json();
    assert.ok(Array.isArray(series));
    assert.ok(series.every((p: any) => 'raw' in p && 'avg' in p));
    assert.ok('label' in trend);
  });

  test('une date malformee est refusee', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/bodyweight/03-02-2026', headers: auth(), payload: { weight_kg: 80 } });
    assert.equal(res.statusCode, 400);
  });
});

describe('export et restauration (critere 7)', () => {
  test('l export contient toutes les tables et se reimporte a l identique', async () => {
    const dump = (await app.inject({ method: 'GET', url: '/api/export', headers: auth() })).json();
    assert.equal(dump.format, 'turi-kout/v1');
    for (const table of ['exercise', 'routine_day', 'routine_exercise', 'session', 'set_entry',
      'bodyweight', 'meal_template', 'food_log', 'setting', 'muscle', 'exercise_muscle',
      'equipment_item', 'exercise_note', 'exercise_alternative', 'session_swap']) {
      assert.ok(Array.isArray(dump[table]), `table absente : ${table}`);
    }
    assert.equal(dump.routine_exercise.length, 22);
    assert.equal(dump.muscle.length, 12);
    assert.ok(dump.exercise_muscle.length >= 40);

    // On modifie l etat, puis on restaure le dump : l etat doit revenir.
    await app.inject({ method: 'PUT', url: `/api/bodyweight/${dateDaysAgo(1)}`, headers: auth(), payload: { weight_kg: 99 } });

    const restore = await app.inject({ method: 'POST', url: '/api/import', headers: auth(), payload: dump });
    assert.equal(restore.statusCode, 200);

    const after = (await app.inject({ method: 'GET', url: '/api/export', headers: auth() })).json();
    assert.deepEqual(after.bodyweight, dump.bodyweight);
    assert.deepEqual(after.set_entry, dump.set_entry);
    assert.deepEqual(after.routine_exercise, dump.routine_exercise);
    assert.deepEqual(after.muscle, dump.muscle);
    assert.deepEqual(after.exercise_muscle, dump.exercise_muscle);
    assert.deepEqual(after.equipment_item, dump.equipment_item);
    assert.deepEqual(after.exercise_alternative, dump.exercise_alternative);
    assert.deepEqual(after.session_swap, dump.session_swap);
  });
});

describe('validation', () => {
  test('une charge negative est refusee', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id: randomUUID(), session_id: randomUUID(), exercise_id: 1, set_index: 1, weight_kg: -5, reps: 8, done_at: isoDaysAgo(1) },
    });
    assert.equal(res.statusCode, 400);
  });

  test('une serie rattachee a une seance inconnue renvoie 409', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id: randomUUID(), session_id: randomUUID(), exercise_id: 1, set_index: 1, weight_kg: 50, reps: 8, done_at: isoDaysAgo(1) },
    });
    assert.equal(res.statusCode, 409);
  });
});

// ===========================================================================
// v2
// ===========================================================================

describe('chargement initial v2', () => {
  test('le bootstrap transporte muscles, materiel et records', async () => {
    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();

    assert.equal(data.muscles.length, 12, 'les douze groupes musculaires');
    assert.ok(data.exerciseMuscles.length >= 40, 'la cartographie des exercices du seed');
    assert.ok(data.equipment.some((e: any) => e.kind === 'plate'), 'un inventaire de disques');
    assert.ok(data.equipment.some((e: any) => e.kind === 'dumbbell'), 'une gamme d halteres');
    assert.ok(Array.isArray(data.records));

    const bench = data.exercises.find((e: any) => e.name === 'Développé couché');
    assert.equal(bench.equipment, 'barbell');
    assert.equal(bench.bar_kg, 20);

    const mapping = data.exerciseMuscles.filter((m: any) => m.exercise_id === bench.id);
    assert.equal(mapping.find((m: any) => m.muscle_id === 'chest').share, 1, 'pectoraux moteurs');
    assert.equal(mapping.find((m: any) => m.muscle_id === 'triceps').share, 0.5, 'triceps synergistes');

    const chest = data.muscles.find((m: any) => m.id === 'chest');
    assert.equal(chest.mev, 8);
    assert.equal(chest.mrv, 22);
  });

  test('les reglages ont des valeurs par defaut', async () => {
    const settings = (await app.inject({ method: 'GET', url: '/api/settings', headers: auth() })).json();
    assert.equal(settings.rpe_enabled, 0, 'le RPE reste eteint : il ajoute une rangee de saisie');
    assert.equal(settings.warmup_enabled, 1, "l'echauffement guide est actif d'office");
    assert.equal(settings.deload_percent, 10);
  });
});

describe('series v2', () => {
  const sessionId = randomUUID();

  test('une serie porte son type et son RPE', async () => {
    await app.inject({
      method: 'POST', url: '/api/sessions', headers: auth(),
      payload: { id: sessionId, routine_day_id: 1, started_at: isoDaysAgo(1) },
    });

    const warmup = randomUUID();
    const working = randomUUID();
    await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id: warmup, session_id: sessionId, exercise_id: 1, set_index: 1, weight_kg: 40, reps: 8, done_at: isoDaysAgo(1), kind: 'warmup' },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id: working, session_id: sessionId, exercise_id: 1, set_index: 1, weight_kg: 90, reps: 5, done_at: isoDaysAgo(1), kind: 'work', rpe: 8.5 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().kind, 'work');
    assert.equal(res.json().rpe, 8.5);

    const history = (await app.inject({ method: 'GET', url: '/api/exercises/1/history?limit=1', headers: auth() })).json();
    assert.equal(history.find((h: any) => h.id === warmup).kind, 'warmup');
  });

  test("une serie sans type — file d'attente v1 — reste une serie de travail", async () => {
    const id = randomUUID();
    const res = await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id, session_id: sessionId, exercise_id: 1, set_index: 2, weight_kg: 90, reps: 5, done_at: isoDaysAgo(1) },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().kind, 'work');
    assert.equal(res.json().rpe, null);
  });

  test('un lot de synchronisation v1 passe sans modification', async () => {
    const ops = [{
      opId: randomUUID(),
      type: 'set.create',
      payload: { id: randomUUID(), session_id: sessionId, exercise_id: 1, set_index: 3, weight_kg: 90, reps: 5, done_at: isoDaysAgo(1) },
    }];
    const res = (await app.inject({ method: 'POST', url: '/api/sync', headers: auth(), payload: { ops } })).json();
    assert.equal(res.applied.length, 1);
    assert.deepEqual(res.failed, []);
  });

  test('un RPE hors echelle est refuse', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id: randomUUID(), session_id: sessionId, exercise_id: 1, set_index: 4, weight_kg: 90, reps: 5, done_at: isoDaysAgo(1), rpe: 12 },
    });
    assert.equal(res.statusCode, 400);
  });

  const recordFor = async (kind: string) =>
    (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json()
      .records.find((r: any) => r.exercise_id === 1 && r.kind === kind);

  test('un echauffement, meme tres lourd, ne fait pas record', async () => {
    await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id: randomUUID(), session_id: sessionId, exercise_id: 1, set_index: 5, weight_kg: 300, reps: 5, done_at: isoDaysAgo(1), kind: 'warmup' },
    });
    assert.notEqual((await recordFor('weight')).value, 300);
  });

  test('corriger une serie corrige le record, sans table a resynchroniser', async () => {
    const id = randomUUID();
    await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id, session_id: sessionId, exercise_id: 1, set_index: 6, weight_kg: 120, reps: 5, done_at: isoDaysAgo(1) },
    });
    assert.equal((await recordFor('weight')).value, 120);
    // Brzycki : 120 x 36 / (37 - 5) = 135
    assert.equal((await recordFor('e1rm')).value, 135);

    // Erreur de saisie corrigee a posteriori : le record doit retomber tout seul.
    await app.inject({ method: 'PATCH', url: `/api/sets/${id}`, headers: auth(), payload: { weight_kg: 60 } });
    assert.ok((await recordFor('weight')).value < 120);

    // Et disparaitre completement si la serie est supprimee.
    await app.inject({ method: 'DELETE', url: `/api/sets/${id}`, headers: auth() });
    assert.ok((await recordFor('weight')).value <= 90);
  });
});

describe('volume par muscle', () => {
  test('les statistiques rendent des semaines et leurs reperes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats/volume?weeks=4', headers: auth() });
    assert.equal(res.statusCode, 200);

    const { weeks, muscles } = res.json();
    assert.equal(weeks.length, 4, 'quatre semaines continues, meme vides');
    assert.ok(weeks.every((w: any) => /^\d{4}-\d{2}-\d{2}$/.test(w.week)));
    assert.equal(muscles.length, 12);

    const trained = weeks.some((w: any) => Object.keys(w.byMuscle).length > 0);
    assert.ok(trained, 'les series de la semaine ont produit du volume');
  });
});

describe('materiel', () => {
  test("l inventaire se remplace en bloc", async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/equipment', headers: auth(),
      payload: [
        { kind: 'plate', weight_kg: 20, count: 2 },
        { kind: 'plate', weight_kg: 10, count: 2 },
        { kind: 'dumbbell', weight_kg: 12 },
      ],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().length, 3);
    assert.equal(res.json().find((i: any) => i.kind === 'dumbbell').count, 1, 'un haltere par defaut');
  });

  test('un disque de poids nul est refuse', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/equipment', headers: auth(), payload: [{ kind: 'plate', weight_kg: 0 }],
    });
    assert.equal(res.statusCode, 400);
  });

  test("la cartographie musculaire d un exercice se remplace", async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/exercises/1/muscles', headers: auth(),
      payload: [{ muscle_id: 'chest', share: 1 }, { muscle_id: 'triceps', share: 0.5 }],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().length, 2);
  });

  test('une part autre que 1 ou 0,5 est refusee', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/exercises/1/muscles', headers: auth(),
      payload: [{ muscle_id: 'chest', share: 0.75 }],
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('charges au poids du corps et notes (v3)', () => {
  const sessionId = randomUUID();
  let pullups = 0;

  test('une traction sans lest produit enfin un record', async () => {
    const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    pullups = boot.exercises.find((e: any) => e.name === 'Tractions').id;
    assert.equal(boot.exercises.find((e: any) => e.name === 'Tractions').bodyweight_factor, 1);
    assert.equal(boot.exercises.find((e: any) => e.name === 'Rowing haltère').unilateral, 1);

    await app.inject({ method: 'PUT', url: `/api/bodyweight/${dateDaysAgo(2)}`, headers: auth(), payload: { weight_kg: 80 } });
    await app.inject({
      method: 'POST', url: '/api/sessions', headers: auth(),
      payload: { id: sessionId, routine_day_id: 3, started_at: isoDaysAgo(1) },
    });
    await app.inject({
      method: 'POST', url: '/api/sets', headers: auth(),
      payload: { id: randomUUID(), session_id: sessionId, exercise_id: pullups, set_index: 1, weight_kg: 0, reps: 8, done_at: isoDaysAgo(1) },
    });

    const records = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json().records;
    const weight = records.find((r: any) => r.exercise_id === pullups && r.kind === 'weight');
    assert.equal(weight?.value, 80, 'le corps est la charge');
    // Epley : 80 x (1 + 8/30) = 101,3
    assert.equal(records.find((r: any) => r.exercise_id === pullups && r.kind === 'e1rm')?.value, 101.3);
  });

  test('une note se rattache a un exercice et a une seance', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/exercise-notes', headers: auth(),
      payload: { exercise_id: pullups, session_id: sessionId, note: 'Prise large, épaule ok' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().note, 'Prise large, épaule ok');

    const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    assert.equal(boot.exerciseNotes.length, 1);
    assert.equal(boot.exerciseNotes[0].exercise_id, pullups);
  });

  test('une note vidée est supprimée', async () => {
    await app.inject({
      method: 'PUT', url: '/api/exercise-notes', headers: auth(),
      payload: { exercise_id: pullups, session_id: sessionId, note: '   ' },
    });
    const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    assert.equal(boot.exerciseNotes.length, 0);
  });

  test('une note passe par la file de synchronisation', async () => {
    const res = (await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(),
      payload: { ops: [{ opId: randomUUID(), type: 'note.upsert', payload: { exercise_id: pullups, session_id: sessionId, note: 'via la file' } }] },
    })).json();
    assert.equal(res.applied.length, 1);
    assert.deepEqual(res.failed, []);

    const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    assert.equal(boot.exerciseNotes[0].note, 'via la file');
  });
});

describe('alternatives et remplacements (v5)', () => {
  let bench = 0;
  let chestPress = 0;
  const sessionId = randomUUID();

  test('chaque exercice du programme propose des remplacants', async () => {
    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    bench = data.exercises.find((e: any) => e.name === 'Développé couché').id;
    chestPress = data.exercises.find((e: any) => e.name === 'Développé couché machine').id;

    const forBench = data.alternatives.filter((a: any) => a.exercise_id === bench);
    const names = forBench.map((a: any) => data.exercises.find((e: any) => e.id === a.alternative_id).name);
    assert.ok(names.includes('Développé couché machine'), 'la machine remplace la barre');
    assert.ok(names.includes('Dips assistés'));

    // Le lien vaut dans les deux sens : depuis la machine on doit pouvoir revenir.
    const back = data.alternatives.filter((a: any) => a.exercise_id === chestPress);
    assert.ok(back.some((a: any) => a.alternative_id === bench), 'le lien est reciproque');
  });

  test('le materiel de salle est correctement decrit', async () => {
    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    const byName = (name: string) => data.exercises.find((e: any) => e.name === name);

    assert.equal(byName('Développé couché machine').equipment, 'machine');
    assert.equal(byName('Développé couché à la Smith').bar_kg, 15, 'la barre de Smith est plus legere');
    assert.equal(byName('Curl barre EZ').bar_kg, 10);
    assert.equal(byName('Écarté à la poulie vis-à-vis').equipment, 'cable');
    assert.equal(byName('Pompes').bodyweight_factor, 0.65, 'les pompes ne portent pas tout le corps');
    assert.equal(byName('Fentes bulgares').unilateral, 1);
  });

  test('un remplacement ne vaut que pour la seance', async () => {
    await app.inject({
      method: 'POST', url: '/api/sessions', headers: auth(),
      payload: { id: sessionId, routine_day_id: 1, started_at: isoDaysAgo(1) },
    });

    const res = await app.inject({
      method: 'PUT', url: '/api/session-swaps', headers: auth(),
      payload: { session_id: sessionId, planned_id: bench, actual_id: chestPress },
    });
    assert.equal(res.statusCode, 200);

    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    assert.equal(data.swaps.length, 1);
    assert.equal(data.swaps[0].actual_id, chestPress);

    // Le programme n'a pas bouge : la machine sera peut-etre libre la prochaine fois.
    const slot = data.routineExercises.find((r: any) => r.routine_day_id === 1 && r.exercise_id === bench);
    assert.ok(slot, "l'exercice prevu reste au programme");
  });

  test('le remplacement se retire', async () => {
    await app.inject({
      method: 'PUT', url: '/api/session-swaps', headers: auth(),
      payload: { session_id: sessionId, planned_id: bench, actual_id: null },
    });
    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    assert.equal(data.swaps.length, 0);
  });

  test('un remplacement passe par la file de synchronisation', async () => {
    const res = (await app.inject({
      method: 'POST', url: '/api/sync', headers: auth(),
      payload: { ops: [
        { opId: randomUUID(), type: 'swap.set', payload: { session_id: sessionId, planned_id: bench, actual_id: chestPress } },
      ] },
    })).json();
    assert.equal(res.applied.length, 1);
    assert.deepEqual(res.failed, []);
    assert.equal((await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json().swaps.length, 1);
  });

  test('la liste des alternatives se remplace', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/exercises/${bench}/alternatives`, headers: auth(), payload: [chestPress],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().length, 1);

    const data = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth() })).json();
    assert.ok(
      data.alternatives.some((a: any) => a.exercise_id === chestPress && a.alternative_id === bench),
      'le sens inverse est recree',
    );
  });
});
