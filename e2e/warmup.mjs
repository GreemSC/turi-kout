// L'echauffement doit conduire : un palier a la fois, un repos court entre
// chacun, et le passage automatique a la serie de travail au bout.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { performanceHistory, suggestLoad, warmupRamp } from '../shared/domain.ts';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9411);
const BASE = process.env.BASE ?? 'http://localhost:8099';
const TOKEN = process.env.TOKEN;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => `${tmpdir()}/turi-kout-e2e-${process.pid}-${Date.now()}`;

let apiCookie = '';
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...(apiCookie ? { cookie: apiCookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.()[0]; if (sc) apiCookie = sc.split(';')[0];
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : null;
}

await api('POST', '/api/auth', { token: TOKEN });
await api('PUT', '/api/settings', { warmup_enabled: 1, rpe_enabled: 0 });
for (const s of (await api('GET', '/api/bootstrap')).sessions.filter((x) => !x.ended_at)) {
  await api('PATCH', `/api/sessions/${s.id}`, { ended_at: new Date().toISOString() });
}
let boot = await api('GET', '/api/bootstrap');
const day = boot.routineDays.find((d) => d.name === 'Haut A');

// Journee sans superset : c'est l'echauffement qu'on teste ici, et un
// enchainement changerait le libelle du bouton de validation.
await api('PUT', `/api/routine-days/${day.id}/exercises`, boot.routineExercises
  .filter((r) => r.routine_day_id === day.id)
  .sort((a, b) => a.position - b.position)
  .map((r) => ({
    exercise_id: r.exercise_id, target_sets: r.target_sets, rep_min: r.rep_min,
    rep_max: r.rep_max, rest_seconds: r.rest_seconds, superset_group: null,
  })));
boot = await api('GET', '/api/bootstrap');
const sessionId = crypto.randomUUID();
await api('POST', '/api/sessions', { id: sessionId, routine_day_id: day.id, started_at: new Date().toISOString() });

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${profileDir()}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required'], { stdio: 'ignore' });

// Un test qui echoue coupe avant le kill() final : sans ce filet, l'instance
// survit et continue de synchroniser dans la base du test suivant.
process.on('exit', () => { try { chrome.kill(); } catch { /* deja mort */ } });
for (let i = 0; i < 60; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await wait(250); } }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let nextId = 1; const waiting = new Map(); const problems = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});
const send = (method, params = {}) => { const i = nextId++; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => waiting.set(i, (m) => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); };
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Network.setCookie', { name: 'tk_auth', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true });
await send('Page.navigate', { url: `${BASE}/#/seance` });
await wait(2500);

const state = () => evaluate(`JSON.stringify({
  entete: document.querySelector('header .unit').textContent.replace(/\\s+/g, ' ').trim(),
  bouton: document.querySelector('.validate').textContent.replace(/\\s+/g, ' ').trim(),
  charge: document.querySelector('.value input').value,
  reps: document.querySelector('.reps-row .rep.on')?.textContent.trim() ?? null,
  paliers: [...document.querySelectorAll('.rung')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()),
  courant: document.querySelector('.rung.current')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
  faits: document.querySelectorAll('.rung.done').length,
  minuteur: document.querySelector('.timer .num')?.textContent ?? null,
  enMarche: document.querySelector('.timer.running') !== null,
})`);

// Rampe attendue, calculee depuis le domaine sur les donnees du serveur :
// l'ecran doit afficher exactement cela.
const bench = boot.exercises.find((e) => e.name === 'Développé couché');
const slot = boot.routineExercises.find((r) => r.routine_day_id === day.id && r.exercise_id === bench.id);
// Memes arguments que l'ecran de seance : sans l'historique on manquerait le
// deload, et la rampe calculee ne serait pas celle qui est affichee.
const history = performanceHistory(boot.sets, boot.sessions, bench.id, sessionId, 5);
const suggestion = suggestLoad(history[0] ?? null, slot, bench.increment_kg, {
  exercise: bench,
  inventory: boot.equipment,
  history,
  deloadPercent: boot.settings.deload_percent,
});
const expected = warmupRamp(suggestion.weight_kg, bench, boot.equipment, slot.rest_seconds);

console.log(`Charge de travail suggérée : ${suggestion.weight_kg} kg (${suggestion.reason})`);
console.log('Rampe attendue :', expected.map((e) => `${e.weightKg}×${e.reps} [${e.restSeconds}s]`).join('  '));

const first = JSON.parse(await state());
console.log('Rampe affichée :');
first.paliers.forEach((p) => console.log('   ', p));

const steps = expected.length;
assert.ok(steps >= 2, 'la charge de demonstration doit produire une rampe');
assert.equal(first.paliers.length, steps, 'l ecran affiche exactement la rampe du domaine');
assert.match(first.entete, new RegExp(`échauffement 1/${steps}`));
assert.match(first.bouton, new RegExp(`palier 1/${steps}`));
assert.equal(Number(first.charge), expected[0].weightKg, 'le premier palier est pre-rempli');
assert.equal(Number(first.reps), expected[0].reps);

// --- Parcours complet ------------------------------------------------------
const rests = [];
for (let i = 1; i <= steps; i++) {
  await evaluate(`document.querySelector('.validate').click()`);
  await wait(700);
  const after = JSON.parse(await state());
  rests.push(after.minuteur);

  if (i < steps) {
    assert.equal(after.faits, i, `${i} palier(s) marque(s) comme fait(s)`);
    assert.match(after.entete, new RegExp(`échauffement ${i + 1}/${steps}`), 'on avance d un palier');
    assert.equal(after.enMarche, true, 'un repos court s ouvre entre deux paliers');
    assert.equal(Number(after.charge), expected[i].weightKg, 'le palier suivant est pre-rempli');
    console.log(`Palier ${i} validé → palier ${i + 1} (${after.charge} kg), repos ${after.minuteur}`);
  } else {
    console.log(`Palier ${steps} validé → ${after.entete}, repos ${after.minuteur}`);
    // L'echelle reste a l'ecran, tous barreaux franchis, jusqu'a la premiere
    // serie de travail : on voit ce qu'on vient de faire.
    assert.equal(after.paliers.length, steps, "l'echelle reste visible");
    assert.equal(after.faits, steps, 'tous les barreaux sont franchis');
    assert.match(after.entete, /série 1/, 'on passe a la serie de travail');
    assert.match(after.bouton, /Valider la série 1/);
    assert.equal(Number(after.charge), suggestion.weight_kg, 'la charge de travail est pre-remplie');
  }
}

console.log('Repos observés :', rests.join('  '));
const seconds = (mmss) => Number(mmss.split(':')[0]) * 60 + Number(mmss.split(':')[1]);
for (let i = 0; i < steps; i++) {
  assert.ok(Math.abs(seconds(rests[i]) - expected[i].restSeconds) <= 1,
    `repos du palier ${i + 1} : ${rests[i]} pour ${expected[i].restSeconds} s attendues`);
}
assert.ok(Math.abs(seconds(rests[steps - 1]) - slot.rest_seconds) <= 1,
  'apres le dernier palier, c est le repos de l exercice — une serie de travail suit');

// --- Les paliers sont bien consignes comme echauffement --------------------
await wait(1500);
const sets = (await api('GET', '/api/bootstrap')).sets.filter((s) => s.session_id === sessionId);
const warmups = sets.filter((s) => s.kind === 'warmup');
console.log(`En base : ${warmups.length} échauffements, ${sets.length - warmups.length} série(s) de travail`);
assert.equal(warmups.length, steps);
assert.deepEqual(
  warmups.map((w) => w.weight_kg).sort((a, b) => a - b),
  expected.map((e) => e.weightKg).sort((a, b) => a - b),
  'les charges consignees sont celles de la rampe',
);
assert.ok(warmups.every((w) => w.rpe === null), 'un echauffement ne porte pas de RPE');

if (problems.length) { console.error('ERREURS JS :', problems); process.exitCode = 1; }
else console.log('\nAucune erreur JavaScript. Échauffement guidé vérifié de bout en bout.');

ws.close(); chrome.kill();
