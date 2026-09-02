// Critere d'acceptation 1 : mode avion, une seance complete de douze series,
// puis retour du reseau. Tout doit remonter, sans action manuelle ni doublon.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9355);
const BASE = process.env.BASE ?? 'http://localhost:8099';
const TOKEN = process.env.TOKEN;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = () => `${tmpdir()}/turi-kout-e2e-${process.pid}-${Date.now()}`;

// --- Acces API direct, pour observer l'etat du serveur ----------------------
let apiCookie = '';
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(apiCookie ? { cookie: apiCookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.()[0];
  if (sc) apiCookie = sc.split(';')[0];
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : null;
}

await api('POST', '/api/auth', { token: TOKEN });

// Table rase : on part sans seance ouverte.
for (const s of (await api('GET', '/api/bootstrap')).sessions.filter((x) => !x.ended_at)) {
  await api('PATCH', `/api/sessions/${s.id}`, { ended_at: new Date().toISOString() });
}
const before = await api('GET', '/api/bootstrap');
console.log(`Etat initial : ${before.sessions.length} seances, ${before.sets.length} series.`);

// --- Navigateur -------------------------------------------------------------
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${profileDir()}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required',
], { stdio: 'ignore' });

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
  else if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? ''));
});
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => waiting.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))));
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Network.setCookie', { name: 'tk_auth', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true });

await send('Page.navigate', { url: `${BASE}/#/` });
await wait(2500);

const setOffline = (offline) => send('Network.emulateNetworkConditions', {
  offline, latency: 0, downloadThroughput: offline ? 0 : -1, uploadThroughput: offline ? 0 : -1,
});

// --- Mode avion -------------------------------------------------------------
await setOffline(true);
await wait(600);
assert.equal(await evaluate('navigator.onLine'), false, 'le navigateur doit se croire hors ligne');
console.log('\nMode avion active.');

// Demarrer la seance.
await evaluate(`document.querySelector('.start').click()`);
await wait(900);
const day = await evaluate(`document.querySelector('.tabs button.current')?.textContent.trim().split('\\n')[0]`);
console.log('Seance demarree hors ligne, premier exercice :', day);

// Douze series : quatre sur chacun des trois premiers exercices.
for (let exercise = 0; exercise < 3; exercise++) {
  await evaluate(`document.querySelectorAll('.tabs button')[${exercise}].click()`);
  await wait(350);
  for (let set = 0; set < 4; set++) {
    await evaluate(`document.querySelector('.validate').click()`);
    await wait(300);
  }
}

const shown = await evaluate(`
  (async () => {
    const req = indexedDB.open('turi-kout');
    const db = await new Promise((res) => { req.onsuccess = () => res(req.result); });
    const outbox = await new Promise((res) => {
      const r = db.transaction('outbox').objectStore('outbox').count();
      r.onsuccess = () => res(r.result);
    });
    return JSON.stringify({
      lignesAffichees: document.querySelectorAll('.line').length,
      enAttente: outbox,
      badge: document.querySelector('.badge')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
    });
  })()`);
console.log('Pendant la seance :', shown);

// Terminer la seance, toujours hors ligne.
await evaluate(`document.querySelector('.finish').click()`);
await wait(900);

const serverDuringOffline = await api('GET', '/api/bootstrap');
console.log(`Serveur pendant le mode avion : ${serverDuringOffline.sets.length - before.sets.length} nouvelle(s) serie(s) (attendu 0).`);
assert.equal(serverDuringOffline.sets.length, before.sets.length, 'rien ne doit atteindre le serveur hors ligne');

const queued = JSON.parse(await evaluate(`
  (async () => {
    const req = indexedDB.open('turi-kout');
    const db = await new Promise((res) => { req.onsuccess = () => res(req.result); });
    const rows = await new Promise((res) => {
      const r = db.transaction('outbox').objectStore('outbox').getAll();
      r.onsuccess = () => res(r.result);
    });
    return JSON.stringify({ total: rows.length, types: rows.reduce((a, r) => (a[r.type] = (a[r.type] ?? 0) + 1, a), {}) });
  })()`));
console.log('File d attente :', JSON.stringify(queued));
assert.equal(queued.types['set.create'], 12, 'douze series en file');
assert.equal(queued.types['session.create'], 1);
assert.equal(queued.types['session.update'], 1, 'la fin de seance aussi');

// --- Retour du reseau -------------------------------------------------------
console.log('\nReseau retabli. Aucune action manuelle.');
await setOffline(false);
await wait(5000);

const after = await api('GET', '/api/bootstrap');
const newSets = after.sets.length - before.sets.length;
const newSessions = after.sessions.length - before.sessions.length;
console.log(`Serveur apres synchronisation : +${newSessions} seance, +${newSets} series.`);
assert.equal(newSets, 12, 'les douze series doivent etre remontees');
assert.equal(newSessions, 1);

const remaining = await evaluate(`
  (async () => {
    const req = indexedDB.open('turi-kout');
    const db = await new Promise((res) => { req.onsuccess = () => res(req.result); });
    return new Promise((res) => { const r = db.transaction('outbox').objectStore('outbox').count(); r.onsuccess = () => res(r.result); });
  })()`);
assert.equal(remaining, 0, 'la file doit etre vide');
console.log('File videe, indicateur efface.');

// La seance doit etre marquee terminee cote serveur.
const synced = after.sessions.find((s) => !before.sessions.some((b) => b.id === s.id));
assert.ok(synced?.ended_at, 'la fin de seance doit etre remontee');

// --- Rejeu : le meme lot renvoye ne doit rien dupliquer ---------------------
const replay = await api('POST', '/api/sync', {
  ops: after.sets.filter((s) => s.session_id === synced.id).map((s, i) => ({ opId: `rejeu-${i}-${Date.now()}`, type: 'set.create', payload: s })),
});
const afterReplay = await api('GET', '/api/bootstrap');
assert.equal(replay.applied.length, 12);
assert.equal(afterReplay.sets.length, after.sets.length, 'un rejeu ne doit rien dupliquer');
console.log('Rejeu du meme lot : 12 operations acceptees, 0 doublon.');

if (problems.length) { console.error('ERREURS JS :', problems); process.exitCode = 1; }
else console.log('\nAucune erreur JavaScript. Critere 1 verifie.');

ws.close(); chrome.kill();
