#!/usr/bin/env bash
# selftest.sh - prueft das INSTALLIERTE Harness Ende-zu-Ende in Wegwerf-Repos und einem Wegwerf-Zustandsordner.
# Beruehrt weder echte Repos noch den echten Harness-Zustand. rc 0 = alles gruen.
set -u
CL="$(node -p 'require("path").join(require("os").homedir(), ".claude").replace(/\\/g, "/")')"
T="$(mktemp -d 2>/dev/null || mktemp -d -t harness)"; trap 'rm -rf "$T"' EXIT
# Den Test-Ordner in node's KANONISCHE Form bringen (realpath, Vorwaertsschraegstriche):
# mktemp liefert unter Git Bash einen POSIX-/tmp-Pfad, den node-auf-Windows anders aufloest
# als der Hook (der /tmp-Mount ist kein echter C:\-Pfad). Danach rechnen Test UND Hooks mit
# demselben Pfad, und die within()-/Evidenz-Root-Vergleiche stimmen auch unter Windows.
T="$(node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]).replace(/\\/g,"/"))' "$T" 2>/dev/null || printf '%s' "$T")"
export CLAUDE_HARNESS_STATE="$T/state"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  GRUEN $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ROT   $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (ist=$2 soll=$3)"; fi; }
mkdir -p "$T/keinehooks" "$T/leervorlage"
G()     { git -C "$R" -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c core.hooksPath="$T/keinehooks" "$@" >/dev/null 2>&1; }
ginit() { git -C "$1" init -q --template="$T/leervorlage" 2>/dev/null; }
gate()  { printf '{"session_id":"%s"}' "$1" | node "$CL/hooks/stop-gate.js" >/dev/null 2>"$T/gate.err"; echo $?; }
track() { printf '{"session_id":"%s","tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1" "$2" | node "$CL/hooks/write-tracker.js" >/dev/null 2>&1; }
# guard <tool> <json-tool_input> -> exit-code des state-guard (2 = blockt)
guard() { printf '{"tool_name":"%s","tool_input":%s}' "$1" "$2" | node "$CL/hooks/state-guard.js" >/dev/null 2>"$T/guard.err"; echo $?; }
hashof(){ node -e 'process.stdout.write(require(process.argv[2]).treeHash(process.argv[1]))' "$1" "$CL/hooks/lib/hook-io.js"; }
# Evidenz-Schluessel GENAU wie bin/checks-run bilden: sha1(realpathSync(git-toplevel)).
# NICHT sha1(realpathSync($R)) — unter Windows kann git-toplevel anders lauten als der
# bash-Pfad, dann landet manuell geschriebene Fake-Evidenz auf einem anderen Dateinamen als
# der, den das Gate sucht (dann blockt es aus "keine Checks" statt "unsigniert").
keyof() { node -e 'const cp=require("child_process"),fs=require("fs"),c=require("crypto");const top=cp.execFileSync("git",["-C",process.argv[1],"rev-parse","--show-toplevel"],{encoding:"utf8"}).trim();process.stdout.write(c.createHash("sha1").update(fs.realpathSync(top)).digest("hex"))' "$1"; }

for f in hooks/lib/hook-io.js hooks/stop-gate.js hooks/write-tracker.js hooks/state-guard.js hooks/prod-access-audit.js hooks/memory-commit.js bin/checks-run bin/journal; do
  [ -f "$CL/$f" ] || { echo "  ROT   fehlt: $CL/$f"; exit 1; }
done
node -e 'require(process.argv[1])' "$CL/hooks/lib/hook-io.js" 2>/dev/null && ok "hook-io.js laedt" || bad "hook-io.js laedt nicht"

# ---------- Stop-Gate: Grundverhalten ----------
R="$T/repo mit leerzeichen"; mkdir -p "$R"; ginit "$R"
printf 'exit 0\n' > "$R/.checksrc"; printf 'eins\n' > "$R/code.py"; G add -A; G commit -m init
RR="$(git -C "$R" rev-parse --show-toplevel)"
eq "ohne Schreibzugriff in der Sitzung: Gate laesst durch" "$(gate s0)" "0"
track s1 "$RR/code.py"; printf 'zwei\n' > "$R/code.py"
[ -s "$CLAUDE_HARNESS_STATE/sessions/s1-writes.json" ] && ok "write-tracker hat das Repo erkannt und notiert" || bad "write-tracker hat NICHTS notiert ($RR)"
eq "geschrieben, keine Checks gelaufen: Gate blockt (rc 2)" "$(gate s1)" "2"
( cd "$R" && bash "$CL/bin/checks-run" . >/dev/null 2>&1 ); eq "checks-run gruen" "$?" "0"
eq "nach gruenen Checks: Gate laesst durch" "$(gate s1)" "0"
G add -A; G commit -m "commit desselben Inhalts"
eq "Commit desselben Inhalts entwertet die Evidenz NICHT" "$(gate s1)" "0"
printf 'drei\n' > "$R/code.py"
eq "echte Aenderung nach dem Check: Gate blockt wieder" "$(gate s1)" "2"
grep -q 'veraltet' "$T/gate.err" && ok "Blockgrund: Evidenz veraltet" || bad "Blockgrund veraltet fehlt"
printf 'exit 1\n' > "$R/.checksrc"; ( cd "$R" && bash "$CL/bin/checks-run" . >/dev/null 2>&1 ); eq "rote Checks: checks-run rc 1" "$?" "1"
track s2 "$RR/code.py"; eq "rote Checks: Gate blockt" "$(gate s2)" "2"
gate s2 >/dev/null; gate s2 >/dev/null; eq "nach 3 Blocks laesst das Gate durch (kein Endlos-Loop)" "$(gate s2)" "0"

# ---------- Kein blindes pytest ----------
R="$T/pyrepo"; mkdir -p "$R"; ginit "$R"
printf 'pytest\n' > "$R/requirements.txt"; printf 'def test_live():\n    raise SystemExit("LIVE-TEST LIEF")\n' > "$R/test_live.py"; G add -A; G commit -m init
( cd "$R" && bash "$CL/bin/checks-run" . >"$T/py.out" 2>&1 ); eq "Python-Repo OHNE .checksrc: fail-closed rot" "$?" "1"
grep -q 'blindes pytest ist deaktiviert' "$T/py.out" && ok "Meldung nennt den Grund" || bad "Meldung fehlt"
grep -q 'LIVE-TEST LIEF' "$T/py.out" && bad "der Live-Test wurde AUSGEFUEHRT" || ok "der Live-Test wurde NICHT ausgefuehrt"

# ---------- State-Guard: blockt den direkten Schreibweg ueber die Datei-Werkzeuge ----------
EVJSON="$CLAUDE_HARNESS_STATE/checks-evidence/deadbeef.json"
eq "Write in den checks-evidence-Ordner wird geblockt" "$(guard Write "$(printf '{"file_path":"%s","content":"x"}' "$EVJSON")")" "2"
eq "Edit einer Evidenzdatei wird geblockt" "$(guard Edit "$(printf '{"file_path":"%s"}' "$EVJSON")")" "2"
eq "Write auf das Signatur-Secret wird geblockt" "$(guard Write "$(printf '{"file_path":"%s/.gate-secret","content":"x"}' "$CLAUDE_HARNESS_STATE")")" "2"
LEAF="$T/leaf.json"; ln -s "$EVJSON" "$LEAF" 2>/dev/null
if [ -L "$LEAF" ]; then
  eq "Write auf Blatt-Symlink, der in den Evidenz-Ordner zeigt, wird geblockt" "$(guard Write "$(printf '{"file_path":"%s"}' "$LEAF")")" "2"
else
  echo "  UEBERSPRUNGEN Blatt-Symlink-Test (Symlinks hier nicht unterstuetzt, z.B. Windows ohne Entwicklermodus)"
fi
eq "Write einer normalen Code-Datei laeuft durch" "$(guard Write '{"file_path":"/tmp/egal/code.py","content":"x"}')" "0"
eq "NotebookEdit ausserhalb laeuft durch" "$(guard NotebookEdit '{"notebook_path":"/tmp/x.ipynb"}')" "0"
# Bash ist BEWUSST nicht der Job des Guards (Regex auf Kommandozeilen ist unsicher + macht Fehlalarme);
# Bash-Faelschung faengt die SIGNATUR unten. Der Guard laesst Bash daher durch:
eq "Bash wird vom Guard nicht bewertet (auch mit Evidenz-Bezug) -> durch" "$(guard Bash '{"command":"echo x > ~/.claude/state/checks-evidence/x.json"}')" "0"

# ---------- Signierte Evidenz: DAS ist der Faelschungsschutz ----------
R="$T/hmacrepo"; mkdir -p "$R"; ginit "$R"; printf 'exit 1\n' > "$R/.checksrc"; printf 'c\n' > "$R/c.py"; G add -A; G commit -m init
track sh "$(git -C "$R" rev-parse --show-toplevel)/c.py"
THH="$(hashof "$R")"; KEYH="$(keyof "$R")"; RP="$(cd "$R" && pwd -P)"; mkdir -p "$CLAUDE_HARNESS_STATE/checks-evidence"
printf '{"root":"%s","green":true,"treeHash":"%s"}' "$RP" "$THH" > "$CLAUDE_HARNESS_STATE/checks-evidence/$KEYH.json"
eq "unsignierte Fake-Evidenz (green:true) -> Gate blockt trotzdem" "$(gate sh)" "2"
grep -qi 'signiert\|ungültig\|ungueltig' "$T/gate.err" && ok "Blockgrund nennt die fehlende Signatur" || bad "HMAC-Blockgrund fehlt"
printf '{"root":"%s","green":true,"treeHash":"%s","sig":"deadbeefdeadbeef"}' "$RP" "$THH" > "$CLAUDE_HARNESS_STATE/checks-evidence/$KEYH.json"
eq "Fake-Evidenz mit falscher Signatur -> Gate blockt" "$(gate sh)" "2"
( cd "$R" && printf 'exit 0\n' > .checksrc; bash "$CL/bin/checks-run" . >/dev/null 2>&1 )
eq "echte checks-run erzeugt gueltig signierte Evidenz -> Gate laesst durch" "$(gate sh)" "0"
[ -f "$CLAUDE_HARNESS_STATE/.gate-secret" ] && ok "Signatur-Secret angelegt" || bad "Secret fehlt"

# ---------- Optionaler Hook prod-access-audit: protokolliert bei Konfig-Treffer, blockt NIE, no-op ohne Konfig ----------
# Audit-Ordner via $CLAUDE_HARNESS_AUDIT_DIR umlenken (portabel — funktioniert auch dort,
# wo os.homedir() NICHT per $HOME umlenkbar ist, z.B. Windows).
AUD="$T/auditdir"
printf '{"tool_name":"Bash","tool_input":{"command":"ssh mein-prod-host uptime"},"session_id":"s"}' > "$T/audit-in.json"
CLAUDE_HARNESS_AUDIT_DIR="$AUD" node "$CL/hooks/prod-access-audit.js" < "$T/audit-in.json" >/dev/null 2>&1
eq "prod-audit ohne Konfig: exit 0 (no-op)" "$?" "0"
[ -e "$AUD" ] && bad "prod-audit hat OHNE Konfig protokolliert" || ok "prod-audit ohne Konfig: kein Log"
printf '{"tool_name":"Bash","tool_input":{"command":"psql -h mein-prod-host -c drop"},"session_id":"s"}' > "$T/audit-in2.json"
CLAUDE_HARNESS_AUDIT_DIR="$AUD" HARNESS_PROD_PATTERN='mein-prod-host' node "$CL/hooks/prod-access-audit.js" < "$T/audit-in2.json" >/dev/null 2>&1
eq "prod-audit mit Konfig+Treffer: exit 0 (blockt nie)" "$?" "0"
grep -q 'mein-prod-host' "$AUD/"*.jsonl 2>/dev/null && ok "prod-audit protokolliert den Treffer" || bad "prod-audit hat NICHT protokolliert"
grep -q '"touchesData":true' "$AUD/"*.jsonl 2>/dev/null && ok "prod-audit flaggt Daten-Befehl (touchesData)" || bad "touchesData fehlt"

# ---------- Optionaler Hook memory-commit: no-op ohne Memory-Repo, committet mit Repo, blockt NIE ----------
printf '{"session_id":"s"}' > "$T/mem-in.json"
CLAUDE_HARNESS_MEMORY_REPO="$T/kein_repo" node "$CL/hooks/memory-commit.js" < "$T/mem-in.json" >/dev/null 2>&1
eq "memory-commit ohne Memory-Repo: exit 0 (no-op)" "$?" "0"
MR="$T/memrepo"; mkdir -p "$MR"; git -C "$MR" init -q 2>/dev/null; printf 'x\n' > "$MR/note.md"
GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t \
  CLAUDE_HARNESS_MEMORY_REPO="$MR" node "$CL/hooks/memory-commit.js" < "$T/mem-in.json" >/dev/null 2>&1
eq "memory-commit mit Repo: exit 0" "$?" "0"
[ -z "$(git -C "$MR" -c core.hooksPath="$T/keinehooks" status --porcelain)" ] && ok "memory-commit hat die Aenderung committet" || bad "memory-commit hat NICHT committet"

# ---------- CLI journal: Lauf-Zustand (start/checkpoint/effect-Idempotenz/repair-Budget/run_id-Schutz/resume) ----------
JR="rsel-$$"; jj() { node "$CL/bin/journal" "$@" >/dev/null 2>&1; echo $?; }
eq "journal start: rc0" "$(jj start "$JR" Selbsttest)" "0"
eq "journal checkpoint: rc0" "$(jj checkpoint "$JR" --schritt 2 --status laeuft)" "0"
eq "journal effect neu: rc0" "$(jj effect "$JR" --key k1 --was x)" "0"
eq "journal effect wiederholt: rc3 (idempotent, Wirkung NICHT doppelt)" "$(jj effect "$JR" --key k1 --was x)" "3"
eq "journal repair im Budget: rc0" "$(jj repair "$JR" --max 1)" "0"
eq "journal repair ueber Budget: rc4 (Aufrufer MUSS eskalieren)" "$(jj repair "$JR" --max 1)" "4"
eq "journal run_id mit Pfadanteil wird abgelehnt: rc64" "$(jj show ../etc/passwd)" "64"
eq "journal run_id '.' wird abgelehnt (kein runs/-Kollaps): rc64" "$(jj show .)" "64"
eq "journal run_id '..' wird abgelehnt (kein Ausbruch aus runs/): rc64" "$(jj show ..)" "64"
node "$CL/bin/journal" resume "$JR" 2>/dev/null | grep -q '"weiter_bei_schritt": 2' && ok "journal resume liefert den Stand (Rehydrierung)" || bad "journal resume falsch"

# ---------- journal Nebenläufigkeit: die eigentlichen Sicherheitszusagen (mit Test-Lücke, sonst starten die Prozesse nicht eng genug) ----------
JC="rsel-conc-$$"; node "$CL/bin/journal" start "$JC" >/dev/null 2>&1
CF="$CLAUDE_HARNESS_STATE/runs/$JC/commitments.jsonl"; KF="$CLAUDE_HARNESS_STATE/runs/$JC/checkpoint.json"
for i in 1 2 3 4 5; do JOURNAL_TEST_LUECKE_MS=200 node "$CL/bin/journal" effect "$JC" --key kx --was w >/dev/null 2>&1 & done; wait
CN=$(node -e 'try{const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse).filter(e=>e.key==="kx");process.stdout.write(String(l.length))}catch{process.stdout.write("E")}' "$CF")
eq "journal effect 5x parallel: genau 1 commitment (TOCTOU-sicher, Wirkung nicht doppelt)" "$CN" "1"
for i in 1 2 3 4 5; do JOURNAL_TEST_LUECKE_MS=200 node "$CL/bin/journal" repair "$JC" --max 99 >/dev/null 2>&1 & done; wait
RN=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).reparaturen))}catch{process.stdout.write("E")}' "$KF")
eq "journal repair 5x parallel: 5 Inkremente, keins verloren (Budget bleibt zählbar)" "$RN" "5"

# journal: verwaiste (>Verwaist-Schwelle) Sperre wird gebrochen statt den Lauf für immer stillzulegen
JS="rsel-stale-$$"; node "$CL/bin/journal" start "$JS" >/dev/null 2>&1
mkdir -p "$CLAUDE_HARNESS_STATE/runs/$JS/.lock"; touch -t 200001010000 "$CLAUDE_HARNESS_STATE/runs/$JS/.lock" 2>/dev/null
eq "journal bricht verwaiste Sperre (rc0 statt Timeout)" "$(jj checkpoint "$JS" --schritt 5)" "0"

# journal: nach "kein Lauf"-Fehler bleibt KEINE Sperre liegen (fehler->process.exit räumt via exit-Handler auf)
JE="rsel-nolauf-$$"; jj checkpoint "$JE" --schritt 1 >/dev/null 2>&1
[ ! -e "$CLAUDE_HARNESS_STATE/runs/$JE/.lock" ] && ok "journal Sperre nach Fehler freigegeben (kein Lock-Leak)" || bad "journal Lock-Leak nach Fehler"
eq "journal start direkt nach Fehler geht sofort durch (rc0)" "$(jj start "$JE")" "0"

# journal: grosse resume-Ausgabe wird nicht von process.exit abgeschnitten (bleibt gültiges JSON durch die Pipe)
JB="rsel-big-$$"; node "$CL/bin/journal" start "$JB" >/dev/null 2>&1
node -e 'const fs=require("fs");let s="";for(let i=0;i<4000;i++)s+=JSON.stringify({zeit:"t",art:"artefakt",pfad:"/ein/recht/langer/pfad/zu/artefakt/nummer/"+i+"/ergebnis.json",von:"agent"})+"\n";fs.appendFileSync(process.argv[1],s)' "$CLAUDE_HARNESS_STATE/runs/$JB/history.jsonl"
BIG=$(node "$CL/bin/journal" resume "$JB" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{JSON.parse(d);process.stdout.write("OK")}catch{process.stdout.write("TRUNC")}})')
eq "journal resume: grosse Ausgabe bleibt vollständig (kein stdout-Abschnitt)" "$BIG" "OK"

echo "  SUMME: $PASS gruen, $FAIL rot"; [ "$FAIL" -eq 0 ]
