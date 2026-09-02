#!/usr/bin/env bash
#
# Scenarios de bout en bout : un vrai navigateur pilote par le protocole
# DevTools, contre le build de production.
#
#   npm run build && ./e2e/run.sh
#
# Chaque scenario recoit sa propre base et son propre port. Ils partageaient un
# serveur unique, et les reglages laisses par l'un faisaient echouer le suivant.
set -uo pipefail
# Sans cela, bash annonce chaque serveur qu'on arrete en fin de scenario.
set +m
cd "$(dirname "$0")/.."

: "${CHROME:=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
export CHROME

if [[ ! -x "$CHROME" ]]; then
  echo "Navigateur introuvable : $CHROME"
  echo "Definissez CHROME vers un Chrome ou Chromium."
  exit 1
fi

if [[ ! -f server/dist/index.js ]]; then
  echo "Construisez d'abord : npm run build"
  exit 1
fi

WORK="${TMPDIR:-/tmp}/turi-kout-e2e"
rm -rf "$WORK"; mkdir -p "$WORK"

pkill -f "headless=new" 2>/dev/null || true
sleep 1

port=8200
fail=0

# $1 nom · $2 vierge|demo · $3... commande
run() {
  local label=$1 flavour=$2; shift 2
  port=$((port + 1))
  local cdp=$((9600 + port - 8200))
  local dir="$WORK/$port"
  mkdir -p "$dir"

  AUTH_TOKEN=demo DB_PATH="$dir/turi.sqlite" PORT=$port LOG_LEVEL=warn \
    node server/dist/index.js > "$dir/server.log" 2>&1 &
  local server=$!

  for _ in $(seq 1 40); do
    curl -sf "http://localhost:$port/healthz" > /dev/null && break
    sleep 0.25
  done

  # Le jeu de demonstration se construit par l'API : pas de fixture binaire.
  if [[ $flavour == demo ]]; then
    BASE="http://localhost:$port" TOKEN=demo node e2e/seed.mjs > /dev/null 2>&1
    BASE="http://localhost:$port" TOKEN=demo node e2e/setup.mjs > /dev/null 2>&1
  fi

  printf "%-16s " "$label"
  local out
  out=$(BASE="http://localhost:$port" CDP_PORT=$cdp TOKEN=demo "$@" 2>&1 | tail -1)
  echo "$out"
  [[ "$out" == *"verifi"* || "$out" == *"vérifi"* ]] || fail=1

  kill "$server" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
}

run "premiere seance" vierge node e2e/first.mjs
run "auto"            demo   node e2e/auto.mjs
run "offline"         demo   node e2e/offline.mjs
run "offline-v2"      demo   node e2e/offline-v2.mjs
run "superset"        demo   node e2e/superset.mjs
run "remplacement"    demo   node e2e/swap.mjs
run "timer"           demo   node --experimental-strip-types e2e/timer.mjs
run "echauffement"    demo   node --experimental-strip-types e2e/warmup.mjs

echo
if [[ $fail -eq 0 ]]; then echo "TOUS LES SCENARIOS AU VERT"; else echo "AU MOINS UN SCENARIO EN ECHEC"; fi
exit $fail
