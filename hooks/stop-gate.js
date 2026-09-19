#!/usr/bin/env node
// Stop-Gate: verhindert "fertig", solange Code geändert wurde, ohne dass die
// Checks (typecheck/lint/test) grün gegen den AKTUELLEN Stand gelaufen sind.
// Blockt bis zu MAX_BLOCKS-mal, danach durchlassen (kein Endlos-Loop).
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { readStdinJson, gitRoot, isCodeRepo, treeHash, stateDir, safeMain, evidenceValid } = require('./lib/hook-io.js');
const MAX_BLOCKS = 3;
safeMain(async () => {
  const ev = await readStdinJson();
  const sid = ev.session_id; if (!sid) return;
  // Endlosschutz von Claude Code selbst: wenn wir bereits blocken, nicht erneut aufsummieren
  if (ev.stop_hook_active) { /* weiter, wir prüfen unten sauber */ }
  const writesFile = path.join(stateDir(), 'sessions', `${sid}-writes.json`);
  let writes = { repos: {} };
  try { writes = JSON.parse(fs.readFileSync(writesFile, 'utf8')); } catch { return; } // nichts geschrieben → nichts zu prüfen
  const codeRepos = Object.keys(writes.repos || {}).filter((r) => { try { return isCodeRepo(r); } catch { return false; } });
  if (!codeRepos.length) return;

  const problems = [];
  for (const root of codeRepos) {
    let realRoot; try { realRoot = fs.realpathSync(root); } catch { realRoot = root; }
    const key = crypto.createHash('sha1').update(realRoot).digest('hex');
    let evd = null;
    try { evd = JSON.parse(fs.readFileSync(path.join(stateDir(), 'checks-evidence', key + '.json'), 'utf8')); } catch {}
    if (!evd) problems.push(`${path.basename(root)}: keine Checks gelaufen`);
    else if (!evidenceValid(evd)) problems.push(`${path.basename(root)}: Beleg ungültig oder nicht von checks-run signiert (nicht vertrauenswürdig) — checks-run erneut fahren`);
    else if (!evd.green) problems.push(`${path.basename(root)}: letzte Checks ROT`);
    else if (evd.treeHash !== treeHash(root)) problems.push(`${path.basename(root)}: Code seit dem letzten grünen Check geändert (Evidenz veraltet)`);
  }

  const cntFile = path.join(stateDir(), 'sessions', `${sid}-blocks`);
  if (!problems.length) { try { fs.unlinkSync(cntFile); } catch {}; return; } // verifiziert → durchlassen + zähler reset

  let n = 0; try { n = parseInt(fs.readFileSync(cntFile, 'utf8'), 10) || 0; } catch {}
  if (n >= MAX_BLOCKS) { // eskalations-schutz: durchlassen, aber SICHTBAR unverifiziert
    process.stderr.write('STOP-GATE: ' + MAX_BLOCKS + 'x geblockt - lasse UNVERIFIZIERT durch: ' + problems.join('; ') + '\n');
    return;
  }
  try { fs.writeFileSync(cntFile, String(n + 1)); } catch {}
  process.stderr.write(
    'STOP-GATE: Du willst fertig melden, aber der Code ist nicht verifiziert.\n' +
    problems.map((p) => '  - ' + p).join('\n') +
    '\n\nFühre die Checks aus, bevor du "fertig" sagst:\n' +
    '  ~/.claude/bin/checks-run\n' +
    '(läuft typecheck/lint/test im Repo; grün = du darfst stoppen). Erst nach grün erneut fertig melden.\n'
  );
  process.exit(2);
});
