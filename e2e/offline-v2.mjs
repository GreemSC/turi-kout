// Hors ligne, version v2 : type de serie, RPE et detection de record doivent
// fonctionner sans reseau, puis remonter intacts.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9388);
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
await api('PUT', '/api/settings', { rpe_enabled: 1, warmup_enabled: 1 });
for (const s of (await api('GET', '/api/bootstrap')).sessions.filter((x) => !x.ended_at)) {
  await api('PATCH', `/api/sessions/${s.id}`, { ended_at: new Date().toISOString() });
}
const before = await api('GET', '/api/bootstrap');

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
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Network.setCookie', { name: 'tk_auth', value: TOKEN, domain: 'localhost', path: '/', httpOnly: true });
await send('Page.navigate', { url: `${BASE}/#/` });
await wait(2500);

await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await wait(600);
assert.equal(await evaluate('navigator.onLine'), false);
console.log('Mode avion active.');

await evaluate(`document.querySelector('.start').click()`);
await wait(900);

const exercise = await evaluate(`document.querySelector('.tabs button.current').textContent.trim().split('\\n')[0].trim()`);
console.log('Exercice :', exercise);

// --- Un echauffement, marque comme tel ------------------------------------
const setWeight = (value) => `
  (() => {
    const input = document.querySelector('.value input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${value}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`;

// L'echauffement guide s'ouvre d'office : on valide son premier palier, qui
// doit etre consigne comme echauffement et remonter tel quel.
const hasRamp = await evaluate(`document.querySelectorAll('.rung').length > 0`);
console.log('echelle ouverte a l arrivee :', hasRamp);
if (hasRamp) {
  await evaluate(`document.querySelector('.validate').click()`);
  await wait(500);
  const warmLine = await evaluate(`
    document.querySelector('.rung.done')?.textContent.replace(/\\s+/g, ' ').trim()
    ?? document.querySelector('.warmline')?.textContent.replace(/\\s+/g, ' ').trim() ?? null`);
  console.log('Palier consigne :', warmLine);
  assert.ok(warmLine, "le palier valide est marque comme franchi");
}

// On passe le reste de la rampe pour rejoindre les series de travail.
await evaluate(`(() => { const b = document.querySelector('.skip'); if (b) b.click(); })()`);
await wait(400);
await evaluate(setWeight(300));
await wait(200);
console.log('etat avant RPE :', await evaluate(`JSON.stringify({
  rangeeRpe: document.querySelectorAll('.rpe-row .rep').length,
  echelle: document.querySelectorAll('.rung').length,
  bouton: document.querySelector('.validate').textContent.replace(/\\s+/g,' ').trim(),
})`));
await evaluate(`[...document.querySelectorAll('.rpe-row .rep')].find(b => b.textContent.trim() === '9').click()`);
await wait(200);
await evaluate(`document.querySelector('.validate').click()`);
await wait(700);

const records = await evaluate(`[...document.querySelectorAll('.record')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
console.log('Records annonces hors ligne :', JSON.stringify(records));
assert.ok(records.length >= 1, 'un record doit etre detecte sans reseau');
assert.ok(records.some((r) => r.includes('charge')), 'dont le record de charge');

const shown = await evaluate(`document.querySelector('.line:not(.pendingline):not(.past) .cell:nth-child(3)')?.textContent.replace(/\\s+/g,' ').trim()`);
console.log('Ligne du jour :', shown);
assert.ok(shown?.includes('RPE 9'), 'le RPE saisi apparait sur la ligne');

// --- Retour du reseau ------------------------------------------------------
console.log('\nReseau retabli.');
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await wait(5000);

const after = await api('GET', '/api/bootstrap');
const newSets = after.sets.filter((s) => !before.sets.some((b) => b.id === s.id));
console.log(`Remontees : ${newSets.length} series.`);

const warmup = newSets.find((s) => s.kind === 'warmup');
const heavy = newSets.find((s) => s.weight_kg === 300);
assert.ok(warmup, "l'echauffement remonte avec son type");
assert.equal(warmup.rpe, null, 'un echauffement ne porte pas de RPE');
assert.ok(heavy, 'la serie de travail remonte');
assert.equal(heavy.kind, 'work');
assert.equal(heavy.rpe, 9, 'le RPE remonte intact');
console.log(`  échauffement : ${warmup.weight_kg} kg, kind=${warmup.kind}, rpe=${warmup.rpe}`);
console.log(`  travail      : ${heavy.weight_kg} kg, kind=${heavy.kind}, rpe=${heavy.rpe}`);

const serverRecord = after.records.find((r) => r.exercise_id === heavy.exercise_id && r.kind === 'weight');
assert.equal(serverRecord.value, 300, 'le serveur confirme le record detecte hors ligne');
console.log(`  record serveur : ${serverRecord.value} kg — confirme`);

const outbox = await evaluate(`
  (async () => {
    const req = indexedDB.open('turi-kout');
    const db = await new Promise((res) => { req.onsuccess = () => res(req.result); });
    return new Promise((res) => { const r = db.transaction('outbox').objectStore('outbox').count(); r.onsuccess = () => res(r.result); });
  })()`);
assert.equal(outbox, 0, 'la file doit etre vide');

if (problems.length) { console.error('ERREURS JS :', problems); process.exitCode = 1; }
else console.log('\nAucune erreur JavaScript. Type de serie, RPE et records verifies hors ligne.');

ws.close(); chrome.kill();
