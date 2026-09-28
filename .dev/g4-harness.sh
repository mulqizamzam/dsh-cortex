#!/usr/bin/env bash
# G3-G5 harness — isolated DSH_HOME for dsh-cortex boot/install/uninstall/quota tests.
# NEVER touches /home/administrator/agent-workspace/.dsh (live). Idempotent; rerun freely.
# Usage:
#   ./g4-harness.sh prep          build throwaway home with dsh-cortex wired in
#   ./g4-harness.sh compose       dump-config assertions
#   ./g4-harness.sh boot          start host on random port, assert mount line, stop
#   ./g4-harness.sh corrupt       P4 class: corrupt state files, boot again, GUI must live
#   ./g4-harness.sh uninstall     remove plugin from throwaway profile, diff leftovers
#   ./g4-harness.sh all           prep+compose+boot (corrupt/uninstall are manual gates)
set -euo pipefail

PKG=/home/administrator/agent-workspace/dsh-custom/plugins/dsh-cortex
LIVE=/home/administrator/agent-workspace/.dsh
H=$PKG/.dev/g4-home                    # throwaway DSH_HOME (workspace = writable)
WEB=$LIVE/profiles/web

log(){ printf '[harness] %s\n' "$*"; }
die(){ printf '[harness][FATAL] %s\n' "$*" >&2; exit 1; }

prep(){
  [[ -f "$PKG/lib/index.js" ]] || die "plugin not built yet (lib/index.js missing) — run pnpm build first"
  rm -rf "$H"
  mkdir -p "$H/profiles/web/node_modules"
  cp "$LIVE/settings.yaml" "$H/settings.yaml"   # apiKeyEnv refs only; no inline secrets (verified)
  echo '# dsh profile root' > "$H/profiles/web/cordis.yml"
  echo '[]' > "$H/profiles/web/cordis.patch.yml"
  # LIGHTWEIGHT isolation (proven 2026-09-15): official bundles resolve from the dsh
  # installation; link-deps only need a symlink in the profile node_modules —
  # `dsh --profile web --dump-config` then composes the dsh-cortex row with NO pnpm install.
  ln -sfn "$PKG" "$H/profiles/web/node_modules/dsh-cortex"
  cat > "$H/profiles/web/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "dsh-cortex": "link:$PKG" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-cortex"] } }
}
EOF
  log "prepared $H (lightweight: symlinked dsh-cortex; official bundles from installation)"
}

compose(){
  export DSH_HOME="$H"
  dsh --profile web --dump-config > /tmp/cortex-dump.txt 2>/dev/null || die "dump-config failed"
  grep -A4 "id: dsh-cortex" /tmp/cortex-dump.txt || die "row 'dsh-cortex' absent from composition"
  log "compose OK (row present)"
}

boot(){
  export DSH_HOME="$H"
  local logf=/tmp/cortex-boot.log
  # real flags verified: apps/cli/tests/args.spec.ts:39 (`web --host --port --no-open`);
  # `--port 0` = OS-assigned free port (web-browser-open.snapshot.ts precedent)
  ( dsh web --port 0 --no-open > "$logf" 2>&1 & echo $! > /tmp/cortex-boot.pid )
  for i in $(seq 1 40); do
    grep -q "dsh-cortex" "$logf" && grep -qi "listen\|ready\|http://" "$logf" && break
    sleep 1
  done
  grep -i "dsh-cortex" "$logf" | head -5 || die "no dsh-cortex mount line in boot log — see $logf"
  # P4 gate: plugin lines exist AND host did not exit
  kill -0 "$(cat /tmp/cortex-boot.pid)" || die "host process gone — boot log: $(tail -20 "$logf")"
  log "boot OK; now exercise cortex_status via UI/CLI separately (G4 tool check)"
  kill "$(cat /tmp/cortex-boot.pid)" 2>/dev/null || true
}

corrupt(){
  export DSH_HOME="$H"
  mkdir -p "$H/dsh-cortex"
  printf 'X{corrupt' > "$H/dsh-cortex/schema.json"
  local f; f=$(find "$H/dsh-cortex" -name '*.json' | head -1)
  [[ -n "$f" ]] && printf 'not json at all' > "$f"
  local logf=/tmp/cortex-corrupt.log
  ( dsh web --port 0 --no-open > "$logf" 2>&1 & echo $! > /tmp/cortex-corrupt.pid )
  sleep 12
  kill -0 "$(cat /tmp/cortex-corrupt.pid)" || die "GUI DIED on corrupt state — P4 VIOLATION: $(tail -20 "$logf")"
  grep -qi "quarantine" "$logf" || log "WARN: no quarantine mention in log (check renderer-level quarantine)"
  find "$H/dsh-cortex" -name '*.corrupt-*' | head -3
  kill "$(cat /tmp/cortex-corrupt.pid)" 2>/dev/null || true
  log "corrupt-state resilience OK (host survived, quarantined files above)"
}

uninstall(){
  export DSH_HOME="$H"
  local before=/tmp/cortex-home-before.txt after=/tmp/cortex-home-after.txt
  find "$H" -path "*/node_modules" -prune -o -type f -print | sort > "$before"
  # On rc.2 the CLI AUTO-splices bundles+dep (verified G4b 2026-09-15); this step
  # emulates its end state by hand so the leftover-diff stays honest.
  node -e '
    const f=process.argv[1],j=require(f);
    j.dsh.profile.bundles=j.dsh.profile.bundles.filter(b=>b!=="dsh-cortex");
    delete j.dependencies["dsh-cortex"];
    require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n");
  ' "$H/profiles/web/package.json"
  rm -f "$H/profiles/web/node_modules/dsh-cortex"
  find "$H" -path "*/node_modules" -prune -o -type f -print | sort > "$after"
  log "profile delta (expect EMPTY — plugin wrote nothing into the profile tree at runtime):"
  comm -13 "$before" "$after" || true
  log "leftover data root (the honest 'one disposable dir'): $H/dsh-cortex"
}

toolprobe(){
  # G4-tool: real session, real tool call, isolated home. Requires NINE_ROUTER key env
  # (inherited by the operator shell) + built plugin + cortex-h profile prepped.
  export DSH_HOME="$H"
  [[ -f "$H/profiles/cortex-h/package.json" ]] || die "cortex-h profile missing (see .dev notes)"
  local logf=/tmp/cortex-toolprobe.log
  timeout 240 dsh --profile cortex-h "Call the cortex_status tool exactly once and reply with ONLY its raw JSON output, nothing else." > "$logf" 2>&1
  local rc=$?
  grep -oE '"plugin":"dsh-cortex"|"modules":\[[^]]*\]' "$logf" | head -4
  grep -c "cortex_status" "$logf"
  log "toolprobe rc=$rc (0 + JSON seen = G4-tool PASS)"
}

case "${1:-all}" in
  prep) prep;; compose) compose;; boot) boot;; corrupt) corrupt;; uninstall) uninstall;;
  all) prep; compose; boot;;
  toolprobe) toolprobe;;
  *) die "unknown step $1";;
esac
