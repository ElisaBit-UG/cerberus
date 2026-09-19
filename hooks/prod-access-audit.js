#!/usr/bin/env node
// PreToolUse (Bash): protokolliert lokal jeden Bash-Befehl, der auf KONFIGURIERTE Prod-Ziele zugreift. Blockt NIE.
//
// Optionaler Zusatz-Hook (Default AUS). Universell: die Prod-Muster kommen aus deiner Umgebung/Konfig,
// NICHTS ist hartkodiert. Ohne Konfiguration = no-op (schreibt nichts, blockt nichts).
//
//   Muster-Quelle (erste nicht-leere gewinnt):
//     1) $HARNESS_PROD_PATTERN            ein oder mehrere Regex, per ";" getrennt
//                                         z. B. "prod-db\.example\.com;10\.0\.0\.5;\bmein-server\b"
//     2) ~/.claude/harness-audit.conf     ein Regex pro Zeile, "#" am Zeilenanfang = Kommentar
//
//   Treffer -> eine JSONL-Zeile an ~/.claude/audit/prod-access-YYYY-MM.jsonl (Modus 600).
//   touchesData markiert Befehle, die Daten anfassen koennten (psql/pg_dump/DROP/DELETE/migrate ...).
//
// Fail-open in jeder Hinsicht: jeder Fehler -> still, exit 0. Ein Audit-Hook darf niemals Arbeit blockieren.
const fs = require('fs'); const path = require('path'); const os = require('os');
try {
  let p = {}; try { p = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { }
  const cmd = (p.tool_name === 'Bash' && p.tool_input && p.tool_input.command) ? String(p.tool_input.command) : '';
  if (!cmd) process.exit(0);

  let pats = [];
  if (process.env.HARNESS_PROD_PATTERN) {
    pats = process.env.HARNESS_PROD_PATTERN.split(';').map((s) => s.trim()).filter(Boolean);
  } else {
    try {
      pats = fs.readFileSync(path.join(os.homedir(), '.claude', 'harness-audit.conf'), 'utf8')
        .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    } catch { }
  }
  if (!pats.length) process.exit(0);                                  // nicht konfiguriert -> no-op

  const compiled = [];
  for (const s of pats) { try { compiled.push(new RegExp(s)); } catch { /* ungueltiges Muster still ignorieren */ } }
  if (!compiled.some((r) => r.test(cmd))) process.exit(0);

  // Zielordner via $CLAUDE_HARNESS_AUDIT_DIR ueberschreibbar (Default ~/.claude/audit) —
  // damit auch dort testbar, wo os.homedir() nicht per $HOME umgelenkt werden kann (Windows).
  const dir = process.env.CLAUDE_HARNESS_AUDIT_DIR || path.join(os.homedir(), '.claude', 'audit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'prod-access-' + new Date().toISOString().slice(0, 7) + '.jsonl');
  fs.appendFileSync(file, JSON.stringify({
    ts: new Date().toISOString(),
    session: p.session_id || null,
    cwd: p.cwd || null,
    command: cmd,
    touchesData: /\b(psql|sqlite3|pg_dump|mysql|mysqldump|mongo|redis-cli)\b|\b(DROP|DELETE|TRUNCATE|ALTER|UPDATE|INSERT)\b|\bmigrate\b|\.dump\b/i.test(cmd),
  }) + '\n', { mode: 0o600 });
} catch { }
process.exit(0);
