const t = process.env.TOKEN ?? 'demo';
const BASE = process.env.BASE ?? 'http://localhost:8099';
let cookie = '';
const call = async (m, p, b) => {
  const r = await fetch(BASE + p, {
    method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: b && JSON.stringify(b),
  });
  const sc = r.headers.getSetCookie?.()[0]; if (sc) cookie = sc.split(';')[0];
  if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + await r.text());
  return r.headers.get('content-type')?.includes('json') ? r.json() : null;
};

await call('POST', '/api/auth', { token: t });
await call('PUT', '/api/settings', { rpe_enabled: 1, warmup_enabled: 1 });

const b = await call('GET', '/api/bootstrap');
console.log('migre :', b.sessions.length, 'seances |', b.sets.length, 'series |',
  b.muscles.length, 'muscles |', b.equipment.length, 'items |', b.records.length, 'records');

for (const s of b.sessions.filter((x) => !x.ended_at)) {
  await call('PATCH', '/api/sessions/' + s.id, { ended_at: new Date().toISOString() });
}

// Une seance ouverte, avec echauffement, series de travail et RPE.
const day = b.routineDays.find((d) => d.name === 'Haut A');
const id = crypto.randomUUID();
await call('POST', '/api/sessions', { id, routine_day_id: day.id, started_at: new Date(Date.now() - 16 * 60000).toISOString() });

const bench = b.exercises.find((e) => e.name === 'Développé couché');
const at = (min) => new Date(Date.now() - min * 60000).toISOString();
await call('POST', '/api/sets', { id: crypto.randomUUID(), session_id: id, exercise_id: bench.id, set_index: 1, weight_kg: 40, reps: 8, done_at: at(14), kind: 'warmup' });
await call('POST', '/api/sets', { id: crypto.randomUUID(), session_id: id, exercise_id: bench.id, set_index: 2, weight_kg: 60, reps: 5, done_at: at(12), kind: 'warmup' });
for (let i = 1; i <= 2; i++) {
  await call('POST', '/api/sets', { id: crypto.randomUUID(), session_id: id, exercise_id: bench.id, set_index: i, weight_kg: 75, reps: 8, done_at: at(9 - i * 3), kind: 'work', rpe: 8 });
}

// Un superset sur la journee Haut A, pour verifier l'enchainement.
const slots = b.routineExercises.filter((r) => r.routine_day_id === day.id).sort((a, c) => a.position - c.position);
await call('PUT', `/api/routine-days/${day.id}/exercises`, slots.map((s, i) => ({
  exercise_id: s.exercise_id, target_sets: s.target_sets, rep_min: s.rep_min, rep_max: s.rep_max,
  rest_seconds: s.rest_seconds, superset_group: i === 4 || i === 5 ? 1 : null,
})));

const v = await call('GET', '/api/stats/volume?weeks=4');
const last = v.weeks[v.weeks.length - 1];
console.log('volume semaine :', Object.entries(last.byMuscle).map(([k, n]) => `${k} ${n}`).join('  ') || '(vide)');
console.log('records dev. couche :', (await call('GET', '/api/bootstrap')).records
  .filter((r) => r.exercise_id === bench.id).map((r) => `${r.kind} ${r.value}`).join('  '));
