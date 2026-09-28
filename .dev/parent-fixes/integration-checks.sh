#!/usr/bin/env bash
# Parent integration checks — run from package root AFTER wave-1 modules land.
# Semua hasilDicatat ke .dev/INTEGRATION-CHECKS-<time>.txt; exit non-zero kalau FAIL keras.
set -uo pipefail
PKGROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$PKGROOT/.dev/INTEGRATION-CHECKS-$(date +%H%M).txt"; : > "$OUT"
note(){ echo "[chk] $*" | tee -a "$OUT"; }
fail=0

cd "$PKGROOT" || exit 1

note "== C1 module dirs =="
ls -d src/host/modules/*/ | tee -a "$OUT"

note "== C2 shared-file authorship (git-less): mtime src/host/{index,rpc,rpc-channels,store,types,config,dsh,dsh-internal}.lib/home.ts newer than FOUNDATION snapshot? (harusnya HANYA parent edits) =="
find src/host/index.ts src/host/rpc.ts src/host/rpc-channels.ts src/host/store.ts src/host/types.ts src/host/config.ts src/host/dsh.ts src/host/dsh-internal.ts src/lib -type f -newer .dev/snapshots/FOUNDATION-1151.tgz 2>/dev/null | tee -a "$OUT"

note "== C3 duplicate tool names across modules (expect: none) =="
grep -rhoE "'cortex_[a-z_0-9]+'" src/host/modules | sort | uniq -d | tee -a "$OUT"

note "== C4 duplicate context names/orders (expect: none) =="
grep -rhoE "cortex:[a-z]+" src/host | sort | uniq -c | sort -rn | tee -a "$OUT"
grep -rn "order: *[0-9]" src/host/modules | tee -a "$OUT"

note "== C5 no webServer usage anywhere in src =="
if grep -rn "webServer" src/ | tee -a "$OUT"; then note "C5 FAIL webServer present"; fail=1; else note "C5 ok"; fi

note "== C6 module writes stay in write-sets =="
grep -rln "from '.*store.ts'" src/host/modules | tee -a "$OUT"
for bad in 'modules/[a-z]*/.*index\.ts' ; do grep -rEl "$bad" src/host/modules 2>/dev/null | tee -a "$OUT"; done

note "== C7 brace literal hygiene in SOURCE strings (crude; whitelist sanitize.ts + tests) =="
grep -rn "{{" src/host --include='*.ts' | grep -v sanitize.ts | grep -v "taskFile" | tee -a "$OUT" || note "C7 clean"

note "== C8 settings namespace single =="
grep -rn "settings.register(" src/host | tee -a "$OUT"

note "== C9 gates =="
timeout 300 ./node_modules/.bin/vitest run 2>&1 | tail -4 | tee -a "$OUT"
./node_modules/.bin/tsc --noEmit -p tsconfig.json; echo "TSC=$?" | tee -a "$OUT"
timeout 240 pnpm run build >/dev/null 2>&1; echo "BUILD=$?" | tee -a "$OUT"
head -c 60 lib/client.js | tee -a "$OUT"; echo | tee -a "$OUT"

note "== C10 dist greps (final artifacts) =="
grep -c "webServer" lib/index.js lib/client.js | tee -a "$OUT"
tr -d '\t\n ' < lib/client.js | grep -oE '__ModuleLoader__\.load\(\{id:"dsh-cortex"' | tee -a "$OUT" || { note "C10 FAIL banner"; fail=1; }

note "DONE fail=$fail"; exit $fail

note "== C11 runtime grep: duplicate context orders (expect distinct 40/41/42[/43]) =="
grep -rhoE "ORDER = [0-9]+" src/host/modules | sort | tee -a "$OUT"
note "== C12 pending.approve must NOT be memory-only after integration (expect: parent dispatcher present) =="
grep -n "pending.approve" src/host/index.ts src/host/modules/*/endpoints.ts src/host/modules/*/rpc.ts 2>/dev/null | tee -a "$OUT"
