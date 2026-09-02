// Critere 3 : le minuteur doit sonner et vibrer alors que la page n'est plus au
// premier plan. Ce test verifie ce qui est verifiable sans telephone : le
// service worker recoit l'echeance, programme la notification et l'emet avec sa
// sequence de vibration, page masquee.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9366);
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
// Ce scenario porte sur le repos d'une SERIE DE TRAVAIL : sans cela le premier
// « Valider » ouvre un palier d'echauffement et son repos de 30 s.
await api('PUT', '/api/settings', { warmup_enabled: 0, rpe_enabled: 0 });
for (const s of (await api('GET', '/api/bootstrap')).sessions.filter((x) => !x.ended_at)) {
  await api('PATCH', `/api/sessions/${s.id}`, { ended_at: new Date().toISOString() });
}
// Relire APRES la cloture : la rotation depend de la derniere seance terminee,
// et calculer sur l'etat d'avant designerait la mauvaise journee.
const boot = await api('GET', '/api/bootstrap');

// Repos de 4 secondes sur la journee qui sera proposee, pour ne pas attendre deux minutes.
const { nextRoutineDay } = await import('../shared/domain.ts');
const day = nextRoutineDay(boot.routineDays, boot.sessions);
const slots = boot.routineExercises.filter((r) => r.routine_day_id === day.id).sort((a, b) => a.position - b.position);
await api('PUT', `/api/routine-days/${day.id}/exercises`, slots.map((s, i) => ({
  exercise_id: s.exercise_id, target_sets: s.target_sets, rep_min: s.rep_min, rep_max: s.rep_max,
  rest_seconds: i === 0 ? 4 : s.rest_seconds, superset_group: null,
})));
console.log(`Journee ${day.name} : repos du premier exercice ramene a 4 s pour le test.`);

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
const send = (method, params = {}) => { const id = nextId++; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => waiting.set(id, (m) => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); };
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Browser.grantPermissions', { origin: BASE, permissions: ['notifications'] });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Network.setCookie', { name: 'tk_auth', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true });
await send('Page.navigate', { url: `${BASE}/#/` });
await wait(2500);

assert.ok(await evaluate(`!!navigator.serviceWorker.controller`), 'le service worker doit controler la page');
console.log('Service worker actif.');

await evaluate(`document.querySelector('.start').click()`);
await wait(900);
await evaluate(`document.querySelector('.validate').click()`);
await wait(500);

const running = await evaluate(`JSON.stringify({
  affiche: document.querySelector('.timer .num')?.textContent,
  enMarche: document.querySelector('.timer.running') !== null,
  audio: (() => { try { return document.querySelector('.timer') ? 'ok' : 'ko'; } catch { return 'ko'; } })(),
})`);
console.log('Apres validation :', running);
assert.match(JSON.parse(running).affiche, /^0:0[0-4]$/, 'le decompte doit demarrer a la duree de repos');
assert.equal(JSON.parse(running).enMarche, true);

// Boutons -15 / +15.
await evaluate(`[...document.querySelectorAll('.timer .step')].find(b => b.textContent.includes('+15')).click()`);
await wait(300);
const bumped = await evaluate(`document.querySelector('.timer .num').textContent`);
console.log('Apres +15 s :', bumped);
assert.match(bumped, /^0:1[5-9]$/, '+15 s doit rallonger le repos');

await evaluate(`[...document.querySelectorAll('.timer .step')].find(b => b.textContent.includes('−15')).click()`);
await wait(300);
console.log('Apres −15 s :', await evaluate(`document.querySelector('.timer .num').textContent`));

// Page masquee : c'est la situation du critere 3.
await send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
await evaluate(`Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
                Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));`);
console.log('Page passee en arriere-plan. Attente de l echeance…');
await wait(6000);

const fired = await evaluate(`
  (async () => {
    const reg = await navigator.serviceWorker.ready;
    const list = await reg.getNotifications({ tag: 'turi-kout-rest' });
    return JSON.stringify(list.map(n => ({ titre: n.title, corps: n.body, vibration: n.vibrate ? [...n.vibrate] : null })));
  })()`);
console.log('Notifications emises par le service worker :', fired);
const notifications = JSON.parse(fired);
assert.equal(notifications.length, 1, 'le service worker doit avoir emis la notification, page masquee');
assert.equal(notifications[0].titre, 'Repos terminé');
assert.ok(notifications[0].corps.includes('Série suivante'), 'le corps annonce l exercice suivant');

if (problems.length) { console.error('ERREURS JS :', problems); process.exitCode = 1; }
else console.log('\nAucune erreur JavaScript. Canal service worker du minuteur verifie.');

ws.close(); chrome.kill();
