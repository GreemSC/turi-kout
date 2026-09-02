import type { FastifyInstance } from 'fastify';

import { db } from './db.ts';
import { COOKIE_NAME, cookieOptions, requireAuth, tokenMatches } from './auth.ts';
import * as store from './store.ts';
import { bodyweightSeries, weeklyTrend } from '../../shared/domain.ts';
import { SYNC_OP_TYPES } from '../../shared/types.ts';
import type { Exercise, SyncOp } from '../../shared/types.ts';

const UUID = { type: 'string', minLength: 8, maxLength: 64 } as const;
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const ISO = { type: 'string', minLength: 10, maxLength: 40 } as const;

const SET_KIND = { type: 'string', enum: ['warmup', 'work', 'failure', 'drop', 'amrap'] } as const;
/** Effort percu : 6 a 10 par pas de 0,5, ou null quand la saisie est desactivee. */
const RPE = { type: ['number', 'null'], minimum: 5, maximum: 10 } as const;
const EQUIPMENT = { type: 'string', enum: ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight'] } as const;

const setBody = {
  type: 'object',
  required: ['id', 'session_id', 'exercise_id', 'set_index', 'weight_kg', 'reps', 'done_at'],
  additionalProperties: false,
  properties: {
    id: UUID,
    session_id: UUID,
    exercise_id: { type: 'integer' },
    set_index: { type: 'integer', minimum: 1 },
    weight_kg: { type: 'number', minimum: 0, maximum: 1000 },
    reps: { type: 'integer', minimum: 0, maximum: 500 },
    done_at: ISO,
    // Absents d'une file remplie par un client v1 : le serveur retombe sur
    // 'work' et null, ce qui reproduit exactement l'ancien comportement.
    kind: SET_KIND,
    rpe: RPE,
  },
} as const;

const sessionBody = {
  type: 'object',
  required: ['id', 'routine_day_id', 'started_at'],
  additionalProperties: false,
  properties: {
    id: UUID,
    routine_day_id: { type: 'integer' },
    started_at: ISO,
    ended_at: { type: ['string', 'null'] },
    note: { type: ['string', 'null'], maxLength: 2000 },
  },
} as const;

const foodBody = {
  type: 'object',
  required: ['id', 'logged_on', 'label', 'kcal', 'protein_g'],
  additionalProperties: false,
  properties: {
    id: UUID,
    logged_on: DATE,
    label: { type: 'string', minLength: 1, maxLength: 120 },
    kcal: { type: 'integer', minimum: 0, maximum: 20000 },
    protein_g: { type: 'integer', minimum: 0, maximum: 2000 },
    template_id: { type: ['integer', 'null'] },
  },
} as const;

const syncOp = {
  type: 'object',
  required: ['opId', 'type', 'payload'],
  additionalProperties: false,
  properties: {
    opId: UUID,
    // Liste unique, partagee avec le client et l'union de types.
    type: { type: 'string', enum: [...SYNC_OP_TYPES] },
    payload: { type: 'object' },
  },
} as const;

export async function registerApi(app: FastifyInstance): Promise<void> {
  // --- Authentification ----------------------------------------------------
  // Seule route publique : elle etablit le cookie que toutes les autres exigent.
  app.post('/api/auth', {
    schema: {
      body: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { token } = request.body as { token: string };
    if (!tokenMatches(token)) return reply.code(401).send({ error: 'bad-token' });
    reply.setCookie(COOKIE_NAME, token, cookieOptions(request));
    return { ok: true };
  });

  await app.register(async (api) => {
    api.addHook('onRequest', requireAuth);

    api.get('/api/auth', async () => ({ ok: true }));

    api.post('/api/logout', async (request, reply) => {
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return { ok: true };
    });

    // --- Chargement initial ------------------------------------------------
    api.get('/api/bootstrap', async () => store.bootstrap());

    // --- Seances -----------------------------------------------------------
    api.post('/api/sessions', { schema: { body: sessionBody } }, async (request) =>
      store.createSession(request.body as never));

    api.patch('/api/sessions/:id', {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { ended_at: { type: ['string', 'null'] }, note: { type: ['string', 'null'], maxLength: 2000 } },
        },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const updated = store.updateSession(id, request.body as never);
      if (!updated) return reply.code(404).send({ error: 'not-found' });
      return updated;
    });

    // --- Series ------------------------------------------------------------
    api.post('/api/sets', { schema: { body: setBody } }, async (request, reply) => {
      try {
        return store.createSet(request.body as never);
      } catch (err) {
        // Seance parente inconnue : contrainte de cle etrangere.
        return reply.code(409).send({ error: (err as Error).message });
      }
    });

    api.patch('/api/sets/:id', {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            weight_kg: { type: 'number', minimum: 0, maximum: 1000 },
            reps: { type: 'integer', minimum: 0, maximum: 500 },
            set_index: { type: 'integer', minimum: 1 },
            kind: SET_KIND,
            rpe: RPE,
          },
        },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const updated = store.updateSet(id, request.body as never);
      if (!updated) return reply.code(404).send({ error: 'not-found' });
      return updated;
    });

    // Idempotent : supprimer deux fois renvoie 200.
    api.delete('/api/sets/:id', async (request) => {
      store.deleteSet((request.params as { id: string }).id);
      return { ok: true };
    });

    api.get('/api/exercises/:id/history', {
      schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
    }, async (request) => {
      const { id } = request.params as { id: string };
      const { limit = 10 } = request.query as { limit?: number };
      return store.exerciseHistory(Number(id), limit);
    });

    // --- Poids corporel ----------------------------------------------------
    api.put('/api/bodyweight/:date', {
      schema: {
        params: { type: 'object', required: ['date'], properties: { date: DATE } },
        body: {
          type: 'object', required: ['weight_kg'], additionalProperties: false,
          properties: { weight_kg: { type: 'number', minimum: 20, maximum: 400 } },
        },
      },
    }, async (request) => {
      const { date } = request.params as { date: string };
      const { weight_kg } = request.body as { weight_kg: number };
      return store.upsertBodyweight({ measured_on: date, weight_kg });
    });

    api.delete('/api/bodyweight/:date', async (request) => {
      store.deleteBodyweight((request.params as { date: string }).date);
      return { ok: true };
    });

    api.get('/api/stats/bodyweight', {
      schema: { querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 3650 } } } },
    }, async (request) => {
      const { days = 90 } = request.query as { days?: number };
      const entries = store.bodyweightRange(days);
      const series = bodyweightSeries(entries, days);
      const settings = store.readSettings();
      return { series, trend: weeklyTrend(series, settings.weekly_gain_target_kg) };
    });

    // --- Volume et materiel ------------------------------------------------
    api.get('/api/stats/volume', {
      schema: { querystring: { type: 'object', properties: { weeks: { type: 'integer', minimum: 1, maximum: 52 } } } },
    }, async (request) => {
      const { weeks = 8 } = request.query as { weeks?: number };
      return store.volumeStats(weeks);
    });

    api.put('/api/equipment', {
      schema: {
        body: {
          type: 'array', maxItems: 200,
          items: {
            type: 'object', required: ['kind', 'weight_kg'], additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['plate', 'dumbbell'] },
              weight_kg: { type: 'number', minimum: 0.25, maximum: 100 },
              count: { type: 'integer', minimum: 1, maximum: 20 },
            },
          },
        },
      },
    }, async (request) => {
      const items = (request.body as { kind: 'plate' | 'dumbbell'; weight_kg: number; count?: number }[])
        .map((i) => ({ kind: i.kind, weight_kg: i.weight_kg, count: i.count ?? (i.kind === 'plate' ? 2 : 1) }));
      return store.saveEquipment(items);
    });

    api.put('/api/session-swaps', {
      schema: {
        body: {
          type: 'object', required: ['session_id', 'planned_id'], additionalProperties: false,
          properties: {
            session_id: UUID,
            planned_id: { type: 'integer' },
            // null retire le remplacement : on refait l'exercice prevu.
            actual_id: { type: ['integer', 'null'] },
          },
        },
      },
    }, async (request) => {
      const body = request.body as { session_id: string; planned_id: number; actual_id?: number | null };
      if (body.actual_id == null) {
        store.clearSwap(body.session_id, body.planned_id);
        return { cleared: true };
      }
      return store.setSwap({ session_id: body.session_id, planned_id: body.planned_id, actual_id: body.actual_id });
    });

    api.put('/api/exercises/:id/alternatives', {
      schema: {
        body: { type: 'array', maxItems: 20, items: { type: 'integer' } },
      },
    }, async (request) =>
      store.saveAlternatives(Number((request.params as { id: string }).id), request.body as number[]));

    api.put('/api/exercise-notes', {
      schema: {
        body: {
          type: 'object', required: ['exercise_id', 'session_id', 'note'], additionalProperties: false,
          properties: {
            exercise_id: { type: 'integer' },
            session_id: UUID,
            note: { type: 'string', maxLength: 2000 },
          },
        },
      },
    }, async (request) => store.saveExerciseNote(request.body as never) ?? { deleted: true });

    api.put('/api/exercises/:id/muscles', {
      schema: {
        body: {
          type: 'array', maxItems: 12,
          items: {
            type: 'object', required: ['muscle_id', 'share'], additionalProperties: false,
            properties: {
              muscle_id: { type: 'string', minLength: 1, maxLength: 40 },
              // 1,0 pour le muscle moteur, 0,5 pour un synergiste.
              share: { type: 'number', enum: [0.5, 1] },
            },
          },
        },
      },
    }, async (request) =>
      store.saveExerciseMuscles(Number((request.params as { id: string }).id), request.body as never));

    // --- Nutrition ---------------------------------------------------------
    api.post('/api/food-log', { schema: { body: foodBody } }, async (request) =>
      store.createFoodLog(request.body as never));

    api.delete('/api/food-log/:id', async (request) => {
      store.deleteFoodLog((request.params as { id: string }).id);
      return { ok: true };
    });

    api.put('/api/meal-templates', {
      schema: {
        body: {
          type: 'array', maxItems: 50,
          items: {
            type: 'object', required: ['name', 'kcal', 'protein_g'], additionalProperties: false,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 60 },
              kcal: { type: 'integer', minimum: 0, maximum: 20000 },
              protein_g: { type: 'integer', minimum: 0, maximum: 2000 },
            },
          },
        },
      },
    }, async (request) => store.saveMealTemplates(request.body as never));

    // --- Programme ---------------------------------------------------------
    api.patch('/api/routine-days/:id', {
      schema: {
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 60 } } },
      },
    }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const day = store.renameRoutineDay(Number(id), (request.body as { name: string }).name);
      if (!day) return reply.code(404).send({ error: 'not-found' });
      return day;
    });

    api.put('/api/routine-days/:id/exercises', {
      schema: {
        body: {
          type: 'array', maxItems: 30,
          items: {
            type: 'object',
            required: ['exercise_id', 'target_sets', 'rep_min', 'rep_max', 'rest_seconds'],
            additionalProperties: false,
            properties: {
              exercise_id: { type: 'integer' },
              position: { type: 'integer' },
              target_sets: { type: 'integer', minimum: 1, maximum: 20 },
              rep_min: { type: 'integer', minimum: 1, maximum: 100 },
              rep_max: { type: 'integer', minimum: 1, maximum: 100 },
              rest_seconds: { type: 'integer', minimum: 0, maximum: 900 },
              superset_group: { type: ['integer', 'null'], minimum: 1, maximum: 20 },
            },
          },
        },
      },
    }, async (request) => store.replaceRoutineExercises(Number((request.params as { id: string }).id), request.body as never));

    api.post('/api/exercises', {
      schema: {
        body: {
          type: 'object', required: ['name', 'muscle_group'], additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            muscle_group: { type: 'string', minLength: 1, maxLength: 40 },
            increment_kg: { type: 'number', minimum: 0, maximum: 50 },
            is_bodyweight: { type: 'integer', enum: [0, 1] },
            equipment: EQUIPMENT,
            bar_kg: { type: ['number', 'null'], minimum: 0, maximum: 60 },
            bodyweight_factor: { type: ['number', 'null'], minimum: 0, maximum: 1 },
            unilateral: { type: 'integer', enum: [0, 1] },
            diagram: { type: ['string', 'null'], maxLength: 40 },
          },
        },
      },
    }, async (request, reply) => {
      const body = request.body as {
        name: string; muscle_group: string; increment_kg?: number; is_bodyweight?: number;
        equipment?: Exercise['equipment']; bar_kg?: number | null;
        bodyweight_factor?: number | null; unilateral?: number; diagram?: string | null;
      };
      const equipment = body.equipment ?? 'barbell';
      try {
        return store.createExercise({
          name: body.name,
          muscle_group: body.muscle_group,
          increment_kg: body.increment_kg ?? 2.5,
          is_bodyweight: body.is_bodyweight ?? (equipment === 'bodyweight' ? 1 : 0),
          equipment,
          bar_kg: body.bar_kg ?? (equipment === 'barbell' ? 20 : null),
          // Un exercice au poids du corps sans coefficient resterait invisible
          // dans le tonnage et les records : on le suppose porte en entier.
          bodyweight_factor: body.bodyweight_factor ?? (equipment === 'bodyweight' ? 1 : null),
          unilateral: body.unilateral ?? 0,
          diagram: body.diagram ?? null,
        });
      } catch {
        return reply.code(409).send({ error: 'nom-deja-pris' });
      }
    });

    api.patch('/api/exercises/:id', {
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            muscle_group: { type: 'string', minLength: 1, maxLength: 40 },
            increment_kg: { type: 'number', minimum: 0, maximum: 50 },
            equipment: EQUIPMENT,
            bar_kg: { type: ['number', 'null'], minimum: 0, maximum: 60 },
            archived_at: { type: ['string', 'null'] },
          },
        },
      },
    }, async (request, reply) => {
      const updated = store.updateExercise(Number((request.params as { id: string }).id), request.body as never);
      if (!updated) return reply.code(404).send({ error: 'not-found' });
      return updated;
    });

    // --- Reglages ----------------------------------------------------------
    api.get('/api/settings', async () => store.readSettings());

    api.put('/api/settings', {
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            kcal_target: { type: 'integer', minimum: 0, maximum: 20000 },
            protein_target_g: { type: 'integer', minimum: 0, maximum: 2000 },
            weekly_gain_target_kg: { type: 'number', minimum: -2, maximum: 2 },
            rpe_enabled: { type: 'integer', enum: [0, 1] },
            warmup_enabled: { type: 'integer', enum: [0, 1] },
            deload_percent: { type: 'integer', minimum: 0, maximum: 50 },
          },
        },
      },
    }, async (request) => store.writeSettings(request.body as never));

    // --- Synchronisation ---------------------------------------------------
    api.post('/api/sync', {
      schema: {
        body: {
          type: 'object', required: ['ops'], additionalProperties: false,
          properties: { ops: { type: 'array', maxItems: 500, items: syncOp } },
        },
      },
    }, async (request) => store.applySync((request.body as { ops: SyncOp[] }).ops));

    // --- Export / restauration ---------------------------------------------
    api.get('/api/export', async (_request, reply) => {
      const stamp = new Date().toISOString().slice(0, 10);
      reply.header('content-disposition', `attachment; filename="turi-kout-${stamp}.json"`);
      return store.exportAll();
    });

    // Restauration d'un dump produit par /api/export : remplace tout le contenu.
    api.post('/api/import', {
      schema: { body: { type: 'object', required: ['format'], properties: { format: { type: 'string', enum: ['turi-kout/v1'] } } } },
    }, async (request) => {
      const dump = request.body as Record<string, Record<string, unknown>[]>;
      const tables = ['muscle', 'exercise', 'exercise_muscle', 'routine_day', 'routine_exercise',
        'session', 'set_entry', 'exercise_note', 'exercise_alternative', 'session_swap',
        'bodyweight', 'meal_template', 'food_log', 'setting', 'equipment_item'];

      db.transaction(() => {
        db.pragma('foreign_keys = OFF');
        for (const name of [...tables].reverse()) db.prepare(`DELETE FROM ${name}`).run();
        for (const name of tables) {
          const rows = dump[name];
          if (!Array.isArray(rows) || rows.length === 0) continue;
          const cols = Object.keys(rows[0]);
          const stmt = db.prepare(
            `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
          );
          for (const row of rows) stmt.run(row);
        }
        db.pragma('foreign_keys = ON');
      })();

      return { ok: true, restored: tables.map((t) => ({ table: t, rows: dump[t]?.length ?? 0 })) };
    });
  });
}
