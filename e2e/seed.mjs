// Remplit une instance de developpement avec trois semaines credibles, pour
// verifier les criteres 4 et 5 de bout en bout et relire les ecrans en situation.
const BASE = process.env.BASE ?? 'http://localhost:8099';
const TOKEN = process.env.TOKEN;

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.()[0];
  if (setCookie) cookie = setCookie.split(';')[0];
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : null;
}

await call('POST', '/api/auth', { token: TOKEN });
const boot = await call('GET', '/api/bootstrap');

const exByName = new Map(boot.exercises.map((e) => [e.name, e]));
const days = boot.routineDays;
const slotsOf = (dayId) => boot.routineExercises.filter((r) => r.routine_day_id === dayId).sort((a, b) => a.position - b.position);

// Charge de depart par exercice, credible pour une prise de masse en cours.
const start = {
  'Développé couché': 72.5, 'Rowing barre': 60, 'Développé militaire': 40, 'Tirage vertical': 55,
  'Élévations latérales': 10, 'Curl biceps': 14, 'Squat': 95, 'Soulevé de terre roumain': 80,
  'Presse à cuisses': 140, 'Leg curl': 45, 'Mollets': 90, 'Développé incliné haltères': 26,
  'Tractions': 0, 'Dips': 0, 'Rowing haltère': 30, 'Curl marteau': 14,
  'Soulevé de terre': 120, 'Fentes': 40, 'Leg extension': 55,
};

const day = (n) => new Date(Date.now() - n * 86_400_000);
const iso = (n, h, m = 0) => {
  const d = day(n); d.setHours(h, m, 0, 0); return d.toISOString();
};

// Huit seances sur 20 jours : deux tours complets de la rotation. La derniere
// est donc Bas B, et la prochaine proposee sera Haut A — la journee dont le
// developpe couche a ete boucle au haut de la fourchette (critere 4).
const offsets = [20, 18, 15, 13, 10, 8, 5, 2];
const loadOf = {};

for (const [i, back] of offsets.entries()) {
  const routineDay = days[i % days.length];
  const id = crypto.randomUUID();
  await call('POST', '/api/sessions', { id, routine_day_id: routineDay.id, started_at: iso(back, 18, 15) });

  let minute = 0;
  for (const slot of slotsOf(routineDay.id)) {
    const name = boot.exercises.find((e) => e.id === slot.exercise_id).name;
    loadOf[name] ??= start[name] ?? 20;

    // La derniere seance de chaque journee est reussie de bout en bout :
    // toutes les series au haut de la fourchette, meme charge. La suivante doit
    // donc proposer la charge incrementee (critere 4).
    const lastPass = i >= days.length;
    for (let s = 1; s <= slot.target_sets; s++) {
      const reps = lastPass ? slot.rep_max : s === slot.target_sets ? Math.max(slot.rep_min, slot.rep_max - 1) : slot.rep_max;
      minute += 3;
      await call('POST', '/api/sets', {
        id: crypto.randomUUID(),
        session_id: id,
        exercise_id: slot.exercise_id,
        set_index: s,
        weight_kg: loadOf[name],
        reps,
        done_at: iso(back, 18, 15 + minute),
      });
    }
    if (lastPass) {
      const increment = boot.exercises.find((e) => e.id === slot.exercise_id).increment_kg;
      loadOf[name] = Math.round((loadOf[name] + increment) * 4) / 4;
    }
  }
  await call('PATCH', `/api/sessions/${id}`, { ended_at: iso(back, 19, 15 + minute) });
}

// Douze pesees sur trois semaines : bruit journalier, tendance de fond a +0,3 kg.
const weighIns = [21, 19, 17, 14, 12, 10, 7, 5, 3, 2, 1, 0];
for (const [idx, back] of weighIns.entries()) {
  const base = 78.2 + (21 - back) * (0.3 / 7);
  // Bruit de somme nulle : la moyenne glissante doit le lisser.
  const noise = [-0.3, 0, 0.3][idx % 3];
  const d = day(back);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await call('PUT', `/api/bodyweight/${date}`, { weight_kg: Math.round((base + noise) * 10) / 10 });
}

await call('PUT', '/api/meal-templates', [
  { name: 'Petit-déj habituel', kcal: 780, protein_g: 42 },
  { name: 'Smoothie protéiné', kcal: 460, protein_g: 38 },
  { name: 'Déjeuner cantine', kcal: 950, protein_g: 45 },
  { name: 'Collation 16 h', kcal: 320, protein_g: 20 },
  { name: 'Dîner riz-poulet', kcal: 820, protein_g: 55 },
]);

const templates = await call('GET', '/api/bootstrap').then((b) => b.mealTemplates);
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
for (const t of templates.slice(0, 3)) {
  await call('POST', '/api/food-log', {
    id: crypto.randomUUID(), logged_on: today, label: t.name, kcal: t.kcal, protein_g: t.protein_g, template_id: t.id,
  });
}

const stats = await call('GET', '/api/stats/bodyweight?days=90');
const bench = exByName.get('Développé couché');
const history = await call('GET', `/api/exercises/${bench.id}/history?limit=1`);

console.log('Seances creees :', offsets.length);
console.log('Tendance poids :', stats.trend.label, `(${stats.trend.status})`);
console.log('Dernier développé couché :', history.map((h) => `${h.weight_kg}×${h.reps}`).join('  '));
