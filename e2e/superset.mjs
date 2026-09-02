// Deux exercices lies s'enchainent sans repos : le minuteur ne doit demarrer
// qu'apres le dernier du groupe.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9399);
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
await api('PUT', '/api/settings', { rpe_enabled: 0, warmup_enabled: 0 });
const boot = await api('GET', '/api/bootstrap');
for (const s of boot.sessions.filter((x) => !x.ended_at)) {
  await api('PATCH', `/api/sessions/${s.id}`, { ended_at: new Date().toISOString() });
}

// Les deux premiers exercices de Haut A sont lies, pour tomber dessus d'emblee.
const day = boot.routineDays.find((d) => d.name === 'Haut A');
const slots = boot.routineExercises.filter((r) => r.routine_day_id === day.id).sort((a, b) => a.position - b.position);
await api('PUT', `/api/routine-days/${day.id}/exercises`, slots.map((s, i) => ({
  exercise_id: s.exercise_id, target_sets: s.target_sets, rep_min: s.rep_min, rep_max: s.rep_max,
  rest_seconds: s.rest_seconds, superset_group: i < 2 ? 1 : null,
})));
const id = crypto.randomUUID();
await api('POST', '/api/sessions', { id, routine_day_id: day.id, started_at: new Date().toISOString() });
console.log('Séance Haut A ouverte, deux premiers exercices liés en superset.');

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
  exercice: document.querySelector('.tabs button.current .tally').previousSibling.textContent.trim(),
  bouton: document.querySelector('.validate').textContent.replace(/\\s+/g, ' ').trim(),
  minuteur: document.querySelector('.timer.running') !== null,
  sousTitre: document.querySelector('.title .unit').textContent.replace(/\\s+/g, ' ').trim(),
})`);

const first = JSON.parse(await state());
console.log('\nAu départ  :', first.exercice, '|', first.bouton);
assert.match(first.sousTitre, /superset 1\/2/, "l'appartenance au groupe est annoncee");
assert.match(first.bouton, /enchaîner/, 'le bouton annonce l enchainement');

await evaluate(`document.querySelector('.validate').click()`);
await wait(800);
const second = JSON.parse(await state());
console.log('Après la 1re :', second.exercice, '|', second.bouton, '| minuteur :', second.minuteur);
assert.notEqual(second.exercice, first.exercice, 'on bascule sur le second exercice du groupe');
assert.equal(second.minuteur, false, 'aucun repos entre les deux maillons');
assert.match(second.sousTitre, /superset 2\/2/);

await evaluate(`document.querySelector('.validate').click()`);
await wait(800);
const third = JSON.parse(await state());
console.log('Après la 2de :', third.exercice, '| minuteur :', third.minuteur);
assert.equal(third.minuteur, true, 'le repos demarre apres le dernier du groupe');
assert.equal(third.exercice, second.exercice, 'on reste sur place pendant le repos');

const remaining = await evaluate(`document.querySelector('.timer .num').textContent`);
console.log('Décompte :', remaining);

if (problems.length) { console.error('ERREURS JS :', problems); process.exitCode = 1; }
else console.log('\nAucune erreur JavaScript. Superset vérifié.');

ws.close(); chrome.kill();
