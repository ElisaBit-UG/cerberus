#!/usr/bin/env node
// PreToolUse (Edit|Write|MultiEdit|NotebookEdit): blockt das direkte Schreiben des Agenten IN den
// Harness-State (~/.claude/state — v.a. Checks-Evidenz und Signatur-Secret) ueber die Datei-Werkzeuge.
// Der Ziel-Pfad wird real aufgeloest (auch Symlinks), es gibt hier keine Textmuster-Rateraum und damit
// keine Fehlalarme.
//
// BEWUSST KEIN Bash-Arm: eine Bash-Kommandozeile ist per Regex NICHT sicher parsebar (ein Red-Team hat
// Glob, Variablen, command-substitution, Grossschreibung als Umgehung nachgewiesen), UND ein Textmuster
// auf 'checks-evidence'/'.gate-secret' blockt faelschlich harmlose Kommandos, die das Wort nur in einer
// Commit-Message oder einem grep tragen. Beides ist unerwuenscht. Die Sicherheit gegen Bash-Faelschung
// traegt die SIGNIERTE Evidenz (hook-io.evidenceSig/-Valid): eine von Hand — egal wie — geschriebene
// Belegdatei ohne gueltige HMAC-Signatur wird vom Stop-Gate verworfen (mit Hinweis auf checks-run).
// Die harte Durchsetzung fuer ALLE (auch einen entschlossenen Agenten, der das Secret liest) leistet erst
// eine externe Instanz (CI auf GitHub, die die Checks selbst faehrt).
// Fail-open: ein Fehler IM Hook blockt keine legitime Arbeit (safeMain).
const fs = require('fs'); const path = require('path');
const { readStdinJson, stateDir, safeMain } = require('./lib/hook-io.js');

const fold = (p) => p.replace(/\\/g, '/').toLowerCase();          // Windows-Backslashes + case-insensitiv
function realDir(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
// Zielpfad aufloesen: existiert die Datei (auch als Symlink), ihren realen Pfad nehmen; sonst
// Elternverzeichnis real + Basisname (fuer noch nicht angelegte Dateien).
function realTarget(p) {
  const abs = path.resolve(p);
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {                                    // Blatt-Symlink: dem Linktext folgen (Ziel darf fehlen)
      const link = fs.readlinkSync(abs);
      const tgt = path.isAbsolute(link) ? link : path.join(path.dirname(abs), link);
      try { return fs.realpathSync(tgt); } catch { }
      return path.join(realDir(path.dirname(tgt)), path.basename(tgt));
    }
  } catch { }
  try { return fs.realpathSync(abs); } catch { }               // existierende Datei
  return path.join(realDir(path.dirname(abs)), path.basename(abs)); // noch nicht angelegt
}
function within(child, parent) {                                  // child == parent oder darunter, case-insensitiv
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

safeMain(async () => {
  const ev = await readStdinJson();
  const t = ev.tool_name || ''; const ti = ev.tool_input || {};
  const stDir = realDir(stateDir());                              // geschuetzt: der GANZE Harness-State
  let hit = false;
  if (t === 'Edit' || t === 'Write' || t === 'MultiEdit' || t === 'NotebookEdit') {
    const fp = ti.file_path || ti.notebook_path || '';
    if (fp) hit = within(realTarget(fp), stDir);
  }
  if (!hit) return;
  process.stderr.write(
    'STATE-GUARD: In den Harness-State (Checks-Evidenz / Signatur-Secret) schreibt der Agent nicht — sonst ' +
    'waere "gruen" faelschbar und das Stop-Gate wertlos. Der Beleg entsteht NUR durch die echten Checks: ' +
    'fuehre ~/.claude/bin/checks-run im betroffenen Repo aus. (Das Gate bewusst umgehen ist eine ' +
    'User-Entscheidung, kein Agenten-Schritt.)\n');
  process.exit(2);
});
