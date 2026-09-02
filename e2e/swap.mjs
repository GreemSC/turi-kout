// Remplacer un exercice doit tout remettre a zero : la charge saisie vaut pour
// l'exercice qu'on quitte, pas pour la machine qu'on prend.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9480);
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
// Ce scenario verifie l'echelle : il ne peut pas heriter du reglage laisse par
// un autre.
await api('PUT', '/api/settings', { warmup_enabled: 1, rpe_enabled: 0 });
for (const s of (await api('GET', '/api/bootstrap')).sessions.filter((x) => !x.ended_at)) {
  await api('PATCH', `/api/sessions/${s.id}`, { ended_at: new Date().toISOString() });
}
const boot = await api('GET', '/api/bootstrap');
const day = boot.routineDays.find((d) => d.name === 'Haut A');
await api('POST', '/api/sessions', { id: crypto.randomUUID(), routine_day_id: day.id, started_at: new Date().toISOString() });

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  `--user-data-dir=${profileDir()}`, '--mute-audio'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
for (let i = 0; i < 60; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await wait(250); } }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 1; const w = new Map(); const problems = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? '');
});
const send = (method, params = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => w.set(i, (m) => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); };
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
  exercice: document.querySelector('h2')?.textContent.trim() ?? null,
  charge: document.querySelector('.value input')?.value ?? null,
  paliers: document.querySelectorAll('.rung').length,
  bouton: document.querySelector('.validate')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
})`);

// --- On saisit une charge sur l'exercice prevu ----------------------------
await evaluate(`
  (() => {
    const i = document.querySelector('.value input');
    const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    s.call(i, '60'); i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
await wait(400);
let now = JSON.parse(await state());
console.log(`Prévu   : ${now.exercice} · ${now.charge} kg · ${now.paliers} paliers`);
assert.equal(now.charge, '60');

// --- Puis la machine est prise : on remplace -------------------------------
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Remplacer').click()`);
await wait(500);
const chosen = await evaluate(`
  (() => {
    const b = document.querySelectorAll('.option')[0];
    const name = b.querySelector('.opt-name').textContent.trim();
    b.click();
    return name;
  })()`);
await wait(700);

now = JSON.parse(await state());
console.log(`Remplacé: ${now.exercice} · ${now.charge} kg · ${now.paliers} paliers · ${now.bouton}`);
assert.match(now.exercice, new RegExp(chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), "l'écran suit le remplaçant");
assert.equal(now.charge, '0',
  "la charge saisie valait pour l'exercice quitté : elle ne doit pas suivre sur une autre machine");
assert.match(now.bouton, /Entrez la charge/, "et le bouton doit la redemander");

// --- Une charge sur le remplacant rouvre bien son echelle ------------------
await evaluate(`
  (() => {
    const i = document.querySelector('.value input');
    const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    s.call(i, '50'); i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
await wait(400);
now = JSON.parse(await state());
console.log(`Charge du remplaçant : ${now.charge} kg · ${now.paliers} paliers · ${now.bouton}`);
assert.ok(now.paliers > 0, "l'échelle du remplaçant doit s'ouvrir");

if (problems.length) { console.error('ERREURS JS :', problems); process.exitCode = 1; }
else console.log('\nAucune erreur JavaScript. Remise a zero au remplacement verifiee.');
ws.close(); chrome.kill();
