#!/usr/bin/env node
// Stop: committet einen Memory-Ordner, der ein EIGENES Git-Repo ist, bei Aenderung automatisch. Best-effort, blockt NIE.
//
// Optionaler Zusatz-Hook (Default AUS). Universell + aus-per-Default: es tut nur etwas, wenn ein solcher Ordner
// wirklich existiert und ein Git-Repo IST. Wer seine Memory bereits anders versioniert (oder gar nicht), merkt nichts.
//
//   Repo-Pfad (erste Variante mit einem .git gewinnt):
//     1) $CLAUDE_HARNESS_MEMORY_REPO
//     2) ~/.claude/memory
//
//   Kein Git-Repo an diesen Orten -> no-op. Fehler beim Committen -> still, exit 0 (ein Stop-Hook blockt nie das Beenden).
const fs = require('fs'); const path = require('path'); const os = require('os');
const { execFileSync } = require('child_process');
try {
  const cands = [process.env.CLAUDE_HARNESS_MEMORY_REPO, path.join(os.homedir(), '.claude', 'memory')].filter(Boolean);
  let repo = null;
  for (const c of cands) { try { if (fs.existsSync(path.join(c, '.git'))) { repo = c; break; } } catch { } }
  if (!repo) process.exit(0);                                         // kein eigenes Memory-Repo -> no-op

  let ev = {}; try { ev = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { }
  const git = (a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).toString();
  if (!git(['status', '--porcelain']).trim()) process.exit(0);       // nichts geaendert
  git(['add', '-A']);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const sid = ev.session_id ? String(ev.session_id).slice(0, 8) : 'unbekannt';
  git(['commit', '-q', '-m', 'memory: auto-commit ' + stamp + ' (session ' + sid + ', ' + os.hostname().split('.')[0] + ')']);
} catch { }
process.exit(0);
