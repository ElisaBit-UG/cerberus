#!/usr/bin/env bash
# install.sh [--uninstall] [--with-audit] [--with-memory-commit]
#   installiert das Stop-Gate-Harness nach ~/.claude (macOS, Linux, Windows mit Git Bash).
# Kopiert die Hook-Dateien, traegt die 3 Kern-Hooks in ~/.claude/settings.json ein, faehrt danach den Selbsttest.
# Optionale Zusatz-Hooks (Default AUS, nur mit Flag aktiv, beide konfig-getrieben + no-op ohne Konfiguration):
#   --with-audit          prod-access-audit  (protokolliert Bash-Zugriffe auf konfigurierte Prod-Ziele; blockt nie)
#   --with-memory-commit  memory-commit      (auto-committet einen Memory-Ordner, der ein eigenes Git-Repo ist)
#   Die Flags definieren den Zustand: laeuft man install.sh spaeter OHNE ein Flag, wird der betreffende Optional-Hook
#   wieder ausgetragen. Zum Behalten das Flag bei jedem Lauf mitgeben. (Die Dateien werden immer kopiert.)
# Ueberschreibt nichts ungesichert: vorhandene Dateien und die settings.json bekommen eine .bak-harness-<TS>-Kopie.
# Beruehrt KEIN Git-Repo und keinen Server. Rueckbau: install.sh --uninstall
# Start: in einem Terminal (unter Windows: Git Bash) mit `bash install.sh` - nicht per Doppelklick, das Fenster schloesse sich sofort.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
say() { echo "[harness-install] $*"; }
die() { echo "[harness-install] ABBRUCH: $*" >&2; exit 9; }
# Flags einsammeln (Reihenfolge egal): Rueckbau + optionale Zusatz-Hooks.
DO_UNINSTALL=0; MERGE_FLAGS=""
for a in "$@"; do
  case "$a" in
    --uninstall)          DO_UNINSTALL=1 ;;
    --with-audit)         MERGE_FLAGS="$MERGE_FLAGS --with-audit" ;;
    --with-memory-commit) MERGE_FLAGS="$MERGE_FLAGS --with-memory-commit" ;;
    *) die "unbekanntes Argument: $a (erlaubt: --uninstall --with-audit --with-memory-commit)" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "node fehlt (mindestens v18): https://nodejs.org"
command -v git  >/dev/null 2>&1 || die "git fehlt"
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "node v$NODE_MAJOR ist zu alt (mindestens v18)"
for f in hooks/lib/hook-io.js hooks/stop-gate.js hooks/write-tracker.js hooks/state-guard.js hooks/prod-access-audit.js hooks/memory-commit.js bin/checks-run bin/journal settings-merge.js selftest.sh; do
  [ -f "$HERE/$f" ] || die "Paket unvollstaendig: $f fehlt"
  # Bash und die Hooks brechen an Windows-Zeilenenden. Das Repo erzwingt LF per /.gitattributes; wer das Paket
  # VOR dieser Regel oder mit einem alten Checkout geholt hat, bekommt CRLF. Dann hier stoppen, BEVOR irgendetwas
  # kopiert oder in die settings.json eingetragen wird.
  if grep -q $'\r' "$HERE/$f"; then
    die "$f hat Windows-Zeilenenden (CRLF). Paket neu auschecken: Repo mit deaktiviertem autocrlf neu klonen/auschecken: git -c core.autocrlf=false clone <repo>  (bzw. Dateien loeschen und git -c core.autocrlf=false checkout -- .)"
  fi
done
# Zielordner so bestimmen, wie die Hooks ihn selbst finden (os.homedir()). Unter Windows kann das $HOME der Git Bash
# davon abweichen - dann laege die Installation an einem Ort, an dem Claude Code und checks-run sie nicht suchen.
CL="$(node -p 'require("path").join(require("os").homedir(), ".claude").replace(/\\/g, "/")')" || die "Home-Verzeichnis nicht bestimmbar"
case "${HOME:-}" in "") ;; *) [ "$(cd "$HOME" 2>/dev/null && pwd -P)" = "$(cd "$(dirname "$CL")" 2>/dev/null && pwd -P)" ] || say "HINWEIS: \$HOME ($HOME) weicht vom Node-Home ab - installiert wird nach $CL (dort suchen die Hooks)" ;; esac

if [ "$DO_UNINSTALL" = 1 ]; then
  if [ -f "$CL/settings.json" ]; then
    node "$HERE/settings-merge.js" "$CL/settings.json" --remove || die "Hook-Eintraege NICHT entfernt - Dateien bleiben aktiv; settings.json zuerst reparieren"
  fi
  for f in hooks/lib/hook-io.js hooks/stop-gate.js hooks/write-tracker.js hooks/state-guard.js hooks/prod-access-audit.js hooks/memory-commit.js bin/checks-run bin/journal; do
    [ -f "$CL/$f" ] && { mv "$CL/$f" "$CL/$f.entfernt-harness-$TS"; say "stillgelegt: $CL/$f"; }
  done
  say "Rueckbau fertig. Zustand unter $CL/state bleibt liegen (loeschbar). Claude Code neu starten."
  exit 0
fi

mkdir -p "$CL/hooks/lib" "$CL/bin" "$CL/state" || die "kann $CL nicht anlegen"
# settings.json VOR dem Kopieren pruefen: ist sie nicht verarbeitbar, wird gar nichts angefasst.
node "$HERE/settings-merge.js" "$CL/settings.json" --check >/dev/null || die "settings.json nicht verarbeitbar (Meldung oben) - nichts installiert"
put() {  # $1=relativer Pfad : kopieren, vorhandene abweichende Datei vorher sichern
  local src="$HERE/$1" dst="$CL/$1"
  if [ -f "$dst" ]; then
    if cmp -s "$src" "$dst"; then say "unveraendert: $1"; return 0; fi
    local bak="$dst.bak-harness-$TS" n=0
    while [ -e "$bak" ]; do n=$((n + 1)); bak="$dst.bak-harness-$TS-$n"; done
    cp -p "$dst" "$bak" || die "Sicherung von $dst gescheitert"
    say "gesichert: $1 -> $(basename "$bak")"
  fi
  cp "$src" "$dst" || die "Kopieren von $1 gescheitert"
  say "installiert: $1"
}
put hooks/lib/hook-io.js; put hooks/stop-gate.js; put hooks/write-tracker.js; put hooks/state-guard.js
put hooks/prod-access-audit.js; put hooks/memory-commit.js; put bin/checks-run; put bin/journal
chmod +x "$CL/bin/checks-run" "$CL/bin/journal" 2>/dev/null || true
node "$HERE/settings-merge.js" "$CL/settings.json" $MERGE_FLAGS || die "settings.json nicht angepasst (siehe Meldung oben) - Dateien sind kopiert, Hooks NICHT aktiv"
case "$MERGE_FLAGS" in *--with-audit*) say "Optional-Hook prod-access-audit AKTIV - Prod-Muster setzen via \$HARNESS_PROD_PATTERN oder ~/.claude/harness-audit.conf (sonst no-op)";; esac
case "$MERGE_FLAGS" in *--with-memory-commit*) say "Optional-Hook memory-commit AKTIV - wirkt nur auf ein Memory-Git-Repo (\$CLAUDE_HARNESS_MEMORY_REPO oder ~/.claude/memory)";; esac
say "CLI 'journal' installiert (Lauf-Zustand, ueberlebt Prozesstod): ~/.claude/bin/journal - kein Hook, wird manuell/vom Agenten aufgerufen (journal start|checkpoint|resume ...)."

say "Selbsttest ..."
if bash "$HERE/selftest.sh"; then
  say "FERTIG. Claude Code NEU STARTEN (Hooks werden beim Sitzungsstart geladen), danach /hooks zur Kontrolle."
else
  die "Selbsttest ROT - Hooks sind eingetragen, aber das Gate arbeitet nicht wie erwartet. Rueckbau: bash $0 --uninstall"
fi
