// Tout doit s'enchainer sans intervention : demarrer la seance ouvre
// l'echauffement, la rampe conduit jusqu'aux series de travail, et l'exercice
// suivant arrive de lui-meme quand les series prevues sont bouclees.
//
// Aucun reglage n'est touche : c'est le comportement par defaut qu'on verifie.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9433);
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
const settings = await api('GET', '/api/settings');
console.log('Réglage d’échauffement à l’arrivée :', settings.warmup_enabled, '(1 = actif d’office)');
assert.equal(settings.warmup_enabled, 1, "l'echauffement guide doit etre actif sans rien regler");

for (const s of (await api('GET', '/api/bootstrap')).sessions.filter((x) => !x.ended_at)) {
  await api('PATCH', `/api/sessions/${s.id}`, { ended_at: new Date().toISOString() });
}

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
await send('Page.navigate', { url: `${BASE}/#/` });
await wait(2500);

const state = () => evaluate(`JSON.stringify({
  exercice: document.querySelector('.tabs button.current .tally')?.previousSibling?.textContent.trim() ?? null,
  onglet: document.querySelector('.tabs button.current .tally')?.textContent.trim() ?? null,
  entete: document.querySelector('header .unit')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
  bouton: document.querySelector('.validate')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
  paliers: document.querySelectorAll('.rung').length,
})`);

// --- Demarrer la seance depuis l'accueil ----------------------------------
await evaluate(`document.querySelector('.start').click()`);
await wait(1200);

let now = JSON.parse(await state());
console.log(`\nSéance démarrée → ${now.exercice} · ${now.entete}`);
assert.ok(now.paliers > 0, "on arrive directement dans l'echauffement, sans rien activer");
assert.match(now.entete, /échauffement 1\//);
const firstExercise = now.exercice;

// --- La rampe se deroule ---------------------------------------------------
const rampSteps = now.paliers;
for (let i = 1; i <= rampSteps; i++) {
  await evaluate(`document.querySelector('.validate').click()`);
  await wait(600);
}
now = JSON.parse(await state());
console.log(`Rampe de ${rampSteps} paliers parcourue → ${now.entete}`);
// L'echelle reste a l'ecran, franchie, jusqu'a la premiere serie de travail.
assert.equal(now.paliers, rampSteps, "l'echelle reste visible une fois gravie");
assert.match(now.entete, /série 1/, 'on est passe aux series de travail tout seul');
assert.equal(now.exercice, firstExercise, 'toujours sur le meme exercice');

// --- Les series de travail, jusqu'a boucler l'exercice --------------------
const plannedSets = Number(now.onglet.split('/')[1]);
console.log(`Séries prévues : ${plannedSets}`);
for (let i = 1; i <= plannedSets; i++) {
  await evaluate(`document.querySelector('.validate').click()`);
  await wait(700);
  const after = JSON.parse(await state());
  if (i < plannedSets) {
    assert.equal(after.exercice, firstExercise, `serie ${i} : on reste sur l exercice`);
  } else {
    console.log(`Série ${i}/${plannedSets} validée → ${after.exercice} · ${after.entete}`);
    assert.notEqual(after.exercice, firstExercise, "l exercice suivant arrive de lui-meme");
  }
}

// --- Et l'exercice suivant enchaine a son tour ----------------------------
now = JSON.parse(await state());
console.log(`Exercice suivant : ${now.exercice} · ${now.entete} · ${now.paliers} palier(s)`);

if (problems.length) { console.error('ERREURS JS :', problems); process.exitCode = 1; }
else console.log('\nAucune erreur JavaScript. Enchaînement automatique vérifié.');

ws.close(); chrome.kill();
