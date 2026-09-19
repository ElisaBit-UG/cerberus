#!/usr/bin/env node
// settings-merge.js <settings.json> [--remove] [--check] [--with-audit] [--with-memory-commit]
// Traegt die drei Kern-Harness-Hooks idempotent in die Claude-Code-Einstellungen ein (oder entfernt sie wieder).
// Fasst NUR eigene Eintraege an: type=command UND das Kommando ist genau `node <pfad>/.claude/hooks/(stop-gate|
// write-tracker|state-guard|prod-access-audit|memory-commit).js` (mit $HOME oder absolutem Pfad, / oder \). Fremde
// Hooks mit zufaellig gleichem Dateinamen an anderem Ort bleiben unberuehrt. Angefasst: Stop, PostToolUse, PreToolUse.
//
// Kern (immer): stop-gate (Stop), write-tracker (PostToolUse), state-guard (PreToolUse).
// Optional (nur mit Flag): --with-audit -> prod-access-audit (PreToolUse) · --with-memory-commit -> memory-commit (Stop).
// Die Flags definieren den GEWUENSCHTEN Zustand: ohne Flag wird ein zuvor eingetragener Optional-Hook wieder entfernt
// (idempotent). Zum Behalten das Flag bei jedem Lauf mitgeben.
// --check prueft nur, ob die Datei verarbeitbar ist (kein Schreiben). Vor jedem Schreiben entsteht eine Sicherung.
const fs = require('fs'); const path = require('path'); const os = require('os');
const args = process.argv.slice(2);
const file0 = args.find((a) => !a.startsWith('--')); const remove = args.includes('--remove'); const checkOnly = args.includes('--check');
const withAudit = args.includes('--with-audit'); const withMem = args.includes('--with-memory-commit');
if (!file0) { console.error('Aufruf: settings-merge.js <pfad/zur/settings.json> [--remove] [--check] [--with-audit] [--with-memory-commit]'); process.exit(9); }
const fwd = (p) => p.replace(/\\/g, '/');
// Absoluter Pfad mit Vorwaertsschraegstrichen: funktioniert unabhaengig davon, welche Shell die Hooks startet
// (ein "$HOME" im Kommando wuerde nur unter bash aufgeloest).
const hookCmd = (name) => 'node "' + fwd(path.join(os.homedir(), '.claude', 'hooks', name)) + '"';
const OURS = /^node\s+"?[^"]*[\\/]\.claude[\\/]hooks[\\/](stop-gate|write-tracker|state-guard|prod-access-audit|memory-commit)\.js"?\s*$/;
const isOurs = (h) => !!h && h.type === 'command' && typeof h.command === 'string' && OURS.test(h.command);
const fail = (msg) => { console.error('ABBRUCH: ' + msg + ' - nichts geaendert.'); process.exit(2); };

let file = file0; let existed = false; let raw = '{}';
try { file = fs.realpathSync(file0); } catch { /* neue Datei */ }          // Symlink: das ZIEL bearbeiten, den Link erhalten
try { raw = fs.readFileSync(file, 'utf8'); existed = true; } catch (e) { if (e.code !== 'ENOENT') fail(file + ' nicht lesbar (' + e.code + ')'); }
raw = raw.replace(/^\uFEFF/, '');                                           // UTF-8-BOM (Windows-Editoren)
let cfg; try { cfg = JSON.parse(raw.trim() === '' ? '{}' : raw); } catch (e) { fail(file + ' ist kein gueltiges JSON (' + e.message + ')'); }
if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) fail('settings.json ist kein JSON-Objekt');
if (cfg.hooks !== undefined && (cfg.hooks === null || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks))) fail('"hooks" ist kein Objekt');
for (const ev of ['Stop', 'PostToolUse', 'PreToolUse']) {
  if (cfg.hooks && cfg.hooks[ev] !== undefined && !Array.isArray(cfg.hooks[ev])) fail('hooks.' + ev + ' ist keine Liste');
}
if (existed) { try { fs.accessSync(file, fs.constants.W_OK); } catch { fail(file + ' ist schreibgeschuetzt'); } }
if (checkOnly) { console.log('settings.json: verarbeitbar'); process.exit(0); }

const before = JSON.stringify(cfg);
cfg.hooks = cfg.hooks || {};
for (const ev of ['Stop', 'PostToolUse', 'PreToolUse']) {                    // nur die eigenen Events
  if (!Array.isArray(cfg.hooks[ev])) continue;
  cfg.hooks[ev] = cfg.hooks[ev]
    .map((g) => {
      if (!g || !Array.isArray(g.hooks)) return g;                          // fremde Form: unangetastet
      const rest = g.hooks.filter((h) => !isOurs(h));
      return rest.length === g.hooks.length ? g : { ...g, hooks: rest, __geleert: rest.length === 0 };
    })
    .filter((g) => !(g && g.__geleert))                                     // nur Gruppen verwerfen, die WIR geleert haben
    .map((g) => { if (g && '__geleert' in g) { const { __geleert, ...r } = g; return r; } return g; });
  if (cfg.hooks[ev].length === 0) delete cfg.hooks[ev];
}
if (!remove) {
  // Stop-Gate als ERSTER Stop-Hook: es prueft, bevor andere Stop-Hooks (z. B. ein Auto-Save) laufen.
  cfg.hooks.Stop = [{ hooks: [{ type: 'command', command: hookCmd('stop-gate.js'), statusMessage: 'Pruefe ob Code verifiziert...' }] }, ...(cfg.hooks.Stop || [])];
  cfg.hooks.PostToolUse = [...(cfg.hooks.PostToolUse || []), { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: hookCmd('write-tracker.js') }] }];
  cfg.hooks.PreToolUse = [...(cfg.hooks.PreToolUse || []), { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: hookCmd('state-guard.js') }] }];
  // Optionale Zusatz-Hooks (nur mit Flag). prod-access-audit blockt nie, memory-commit laeuft NACH dem Stop-Gate.
  if (withAudit) cfg.hooks.PreToolUse = [...cfg.hooks.PreToolUse, { matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('prod-access-audit.js') }] }];
  if (withMem) cfg.hooks.Stop = [...cfg.hooks.Stop, { hooks: [{ type: 'command', command: hookCmd('memory-commit.js') }] }];
}
if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
if (JSON.stringify(cfg) === before) { console.log('settings.json: keine Aenderung noetig'); process.exit(0); }
if (existed) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18) + 'Z';
  let bak = file + '.bak-harness-' + stamp; let n = 0;
  for (;;) { try { fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL); break; } catch (e) { if (e.code !== 'EEXIST' || n > 50) fail('Sicherung gescheitert (' + e.code + ')'); n += 1; bak = file + '.bak-harness-' + stamp + '-' + n; } }
  console.log('Sicherung: ' + bak);
}
const tmp = file + '.tmp-harness-' + process.pid;
try {
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  if (existed) { try { fs.chmodSync(tmp, fs.statSync(file).mode & 0o777); } catch { /* Windows */ } }
  fs.renameSync(tmp, file);
} catch (e) { try { fs.unlinkSync(tmp); } catch { } fail('Schreiben gescheitert (' + e.code + ')'); }
console.log('settings.json: Harness-Hooks ' + (remove ? 'entfernt' : 'eingetragen'));
