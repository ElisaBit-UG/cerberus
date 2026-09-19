#!/usr/bin/env node
// PostToolUse: merkt pro Session, in welchen Git-Repos Code geändert wurde.
// Grundlage für die Stop-Gate: nur wo geschrieben wurde, wird Verifikation verlangt.
const fs = require('fs'); const path = require('path');
const { readStdinJson, gitRoot, stateDir, safeMain, isBashWrite } = require('./lib/hook-io.js');
safeMain(async () => {
  const ev = await readStdinJson();
  const sid = ev.session_id; if (!sid) return;
  let root = null;
  const t = ev.tool_name;
  if (t === 'Edit' || t === 'Write' || t === 'MultiEdit' || t === 'NotebookEdit') {
    const fp = ev.tool_input && (ev.tool_input.file_path || ev.tool_input.notebook_path);
    if (fp) root = gitRoot(path.dirname(fp));
  } else if (t === 'Bash') {
    const cmd = ev.tool_input && ev.tool_input.command;
    if (cmd && ev.cwd && isBashWrite(cmd)) root = gitRoot(ev.cwd);
  }
  if (!root) return;
  const file = path.join(stateDir(), 'sessions', `${sid}-writes.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let j = { repos: {} };
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  j.repos[root] = (j.repos[root] || 0) + 1;
  fs.writeFileSync(file, JSON.stringify(j));
});
