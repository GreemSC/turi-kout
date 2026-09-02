// Installation neuve : aucun historique, donc aucune charge suggeree. C'est le
// cas que les autres tests ne couvraient pas — ils tournaient tous sur des
// donnees de demonstration qui avaient un passe.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9444);
const BASE = process.env.BASE ?? 'http://localhost:8098';
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
const boot = await api('GET', '/api/bootstrap');
assert.equal(boot.sessions.length, 0, 'la base doit etre vierge');
assert.equal(boot.sets.length, 0);
console.log('Base vierge : 0 séance, 0 série.');

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
  entete: document.querySelector('header .unit')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
  bouton: document.querySelector('.validate')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
  charge: document.querySelector('.value input')?.value ?? null,
  paliers: document.querySelectorAll('.rung').length,
  offre: document.querySelector('.validate')?.textContent.includes('Commencer') ? document.querySelector('.validate').textContent.replace(/\\s+/g,' ').trim() : null,
  invite: document.querySelector('.band .label')?.textContent.includes('Première fois') ?? false,
})`);

await evaluate(`document.querySelector('.start').click()`);
await wait(1200);

let now = JSON.parse(await state());
console.log('\nAu démarrage :', now.entete, '| charge', now.charge, '| paliers', now.paliers);
assert.equal(now.paliers, 0, "sans passe, l'application ne peut pas deviner la charge de travail");
assert.equal(now.offre, null, 'et ne propose donc rien encore');
assert.equal(now.charge, '0');
// Rien ne doit pouvoir etre valide a 0 kg : le bouton reclame la charge.
assert.match(now.bouton, /Entrez la charge/, "l'action principale reclame la charge");
console.log('Bouton à 0 kg :', now.bouton);

// --- L'utilisateur saisit sa charge de travail -----------------------------
await evaluate(`
  (() => {
    const input = document.querySelector('.value input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '60');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
await wait(500);

now = JSON.parse(await state());
console.log('Charge saisie 60 kg (à la frappe) → bouton :', now.offre, '| paliers affichés :', now.paliers);
assert.ok(now.paliers >= 2, "l'echelle apparait pendant la frappe, sans quitter le champ");
assert.ok(now.offre, "et l'action principale propose de la commencer");
assert.match(now.offre, /Commencer l'échauffement/);

// --- Un tap, et le guidage prend le relais ---------------------------------
await evaluate(`document.querySelector('.validate').click()`);
await wait(500);

now = JSON.parse(await state());
const steps = now.paliers;
console.log(`Rampe engagée : ${steps} paliers, premier à ${now.charge} kg`);
assert.ok(steps >= 2);
assert.match(now.entete, /échauffement 1\//);
assert.equal(now.charge, '20', 'le premier palier est la barre a vide');

for (let i = 1; i <= steps; i++) {
  await evaluate(`document.querySelector('.validate').click()`);
  await wait(600);
}

now = JSON.parse(await state());
console.log(`Rampe terminée → ${now.entete} | charge ${now.charge} kg`);
// L'echelle reste a l'ecran, franchie, jusqu'a la premiere serie de travail.
assert.equal(now.paliers, steps, "l'echelle reste visible une fois gravie");
assert.match(now.entete, /série 1/);
assert.equal(now.charge, '60', 'la charge de travail saisie est retrouvee, pas remise a zero');

// --- Et la seance suivante sera automatique --------------------------------
await evaluate(`document.querySelector('.validate').click()`);
await wait(1500);
const sets = (await api('GET', '/api/bootstrap')).sets;
const work = sets.filter((s) => s.kind === 'work');
console.log(`En base : ${sets.length - work.length} échauffements, ${work.length} série(s) de travail à ${work[0]?.weight_kg} kg`);
assert.equal(work.length, 1);
assert.equal(work[0].weight_kg, 60);

if (problems.length) { console.error('ERREURS JS :', problems); process.exitCode = 1; }
else console.log('\nAucune erreur JavaScript. Première séance vérifiée.');

ws.close(); chrome.kill();
