import type { Bootstrap, SyncOp, SyncResult } from '../../../shared/types.ts';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(response.status, text || response.statusText);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const api = {
  login: (token: string) => request<{ ok: true }>('POST', '/api/auth', { token }),
  check: () => request<{ ok: true }>('GET', '/api/auth'),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),

  bootstrap: () => request<Bootstrap>('GET', '/api/bootstrap'),
  sync: (ops: SyncOp[]) => request<SyncResult>('POST', '/api/sync', { ops }),

  saveMealTemplates: (templates: { name: string; kcal: number; protein_g: number }[]) =>
    request('PUT', '/api/meal-templates', templates),

  renameRoutineDay: (id: number, name: string) => request('PATCH', `/api/routine-days/${id}`, { name }),
  saveRoutineExercises: (
    dayId: number,
    slots: {
      exercise_id: number; target_sets: number; rep_min: number;
      rep_max: number; rest_seconds: number; superset_group?: number | null;
    }[],
  ) => request('PUT', `/api/routine-days/${dayId}/exercises`, slots),

  saveEquipment: (items: { kind: 'plate' | 'dumbbell'; weight_kg: number; count: number }[]) =>
    request('PUT', '/api/equipment', items),

  saveExerciseMuscles: (exerciseId: number, rows: { muscle_id: string; share: number }[]) =>
    request('PUT', `/api/exercises/${exerciseId}/muscles`, rows),

  saveExerciseNote: (input: { exercise_id: number; session_id: string; note: string }) =>
    request('PUT', '/api/exercise-notes', input),

  saveAlternatives: (exerciseId: number, ids: number[]) =>
    request('PUT', `/api/exercises/${exerciseId}/alternatives`, ids),

  volume: (weeks: number) => request(`GET`, `/api/stats/volume?weeks=${weeks}`),

  createExercise: (input: {
    name: string; muscle_group: string; increment_kg: number;
    is_bodyweight: number; equipment: string; unilateral?: number;
  }) =>
    request('POST', '/api/exercises', input),
  updateExercise: (id: number, patch: Record<string, unknown>) => request('PATCH', `/api/exercises/${id}`, patch),

  saveSettings: (patch: Record<string, number>) => request('PUT', '/api/settings', patch),
};

export type { SyncOp };
