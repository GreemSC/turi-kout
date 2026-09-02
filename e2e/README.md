# Scénarios de bout en bout

Un vrai navigateur, piloté par le protocole DevTools, contre le build de
production. Aucune dépendance : Node fournit `WebSocket`, Chrome fournit le
reste.

```bash
npm run build
npm run e2e
```

Sur Linux, indiquez le navigateur :

```bash
CHROME=$(which chromium) npm run e2e
```

Chaque scénario reçoit **sa propre base et son propre port**. Ils partageaient un
serveur unique, et un réglage laissé par l'un faisait échouer le suivant — trois
fois de suite avant que l'isolation ne soit posée. Un scénario qui dépend d'un
réglage le déclare explicitement dans sa préparation.

| Scénario | Ce qu'il prouve |
| --- | --- |
| `first.mjs` | Base vierge : l'app n'invente pas de charge, la réclame, puis conduit l'échauffement |
| `auto.mjs` | Démarrer une séance ouvre l'échauffement et enchaîne les exercices sans intervention |
| `offline.mjs` | Mode avion : 12 séries loggées, rien n'atteint le serveur, tout remonte sans doublon |
| `offline-v2.mjs` | Type de série, RPE et détection de records fonctionnent hors ligne |
| `superset.mjs` | Deux exercices liés s'enchaînent ; le repos n'attend qu'au dernier |
| `swap.mjs` | Un remplacement remet à zéro la charge : elle valait pour l'exercice quitté |
| `timer.mjs` | Le minuteur sonne page masquée, avec sa séquence de vibration |
| `warmup.mjs` | La rampe affichée est exactement celle du domaine, palier par palier |

`seed.mjs` construit trois semaines d'historique par l'API ; `setup.mjs` ouvre
une séance et active les réglages. Aucune fixture binaire.
