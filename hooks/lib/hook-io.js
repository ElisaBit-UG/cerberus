const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { execFileSync } = require('child_process');

function readStdinJson() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args.split(' ')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}
function gitRoot(p) { try { return git(p, 'rev-parse --show-toplevel'); } catch { return null; } }
function isCodeRepo(root) {
  return ['.checksrc', 'package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'go.mod', 'tsconfig.json']
    .some((f) => fs.existsSync(path.join(root, f)));
}
// M7(a): Im Claude-Config-Repo (~/.claude) aendert Claude Code selbst settings.json und
// plugins/*.json (Modell-Alias, Marketplace-Stand). Diese Runtime-Dateien duerfen die
// Checks-Evidenz nicht entwerten — sonst ist der treeHash nie stabil (Befund F1).
const CONFIG_RUNTIME_EXCLUDES = ['settings.json', 'plugins/'];
function configRoot() {
  const p = process.env.CLAUDE_HARNESS_CONFIG_ROOT || path.join(require('os').homedir(), '.claude');
  try { return fs.realpathSync(p); } catch { return p; }
}
function isConfigRoot(root) {
  try { return fs.realpathSync(root) === configRoot(); } catch { return false; }
}
function isRuntimeFile(rel) {
  return CONFIG_RUNTIME_EXCLUDES.some((x) => x.endsWith('/') ? rel.startsWith(x) : rel === x);
}
// gitZ: wie git(), aber mit Argument-ARRAY (Pfade mit Leerzeichen), optionalem stdin und NUL-Ausgabe.
function gitZ(cwd, args, input) {
  return execFileSync('git', ['-C', cwd, ...args],
    { input: input === undefined ? '' : input, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).toString();
}
// treeHash = Fingerabdruck des INHALTS des Arbeitsbaums (Pfad + Blob-Hash je Datei), NICHT des Commit-Stands.
// Fix 19.09.2026 (Wettlauf Stop-Gate gegen Auto-Save-Hook): die Vorfassung hashte `HEAD` + `git diff HEAD` +
// `git status`. Ein Commit desselben Inhalts (Auto-Save beim Stop) aenderte damit den Hash, die eben erzeugte
// Evidenz galt als "veraltet", obwohl kein Byte Code anders war. Jetzt gilt: gleicher Inhalt = gleicher Hash,
// egal ob committet, gestaged oder untracked. Erfasst wird, was `git add -A` erfassen wuerde
// (getrackt + untracked, .gitignore respektiert). Rein lesend: kein Index-, Objekt- oder Working-Tree-Write.
//   - getrackt + unveraendert : Blob-Hash aus dem Index (Gits Stat-Cache => schnell auch in grossen Repos)
//   - getrackt + veraendert   : `git hash-object` der Arbeitsdatei (gleiche Filter wie `git add` => derselbe
//                               Hash, den der Index NACH dem Commit traegt)
//   - geloescht               : faellt heraus (nach dem Commit steht der Pfad auch nicht mehr im Index)
//   - untracked               : `git hash-object` der Datei
//   - Symlink                 : Blob-Hash des Linktexts (so speichert ihn `git add`), nie der Zielinhalt
// Bewusst NICHT im Hash: Dateimodus (ein reines chmod entwertet die Evidenz nicht) und der Commit-Stand.
function treeHash(root) {
  const excl = isConfigRoot(root);
  const keep = (rel) => !(excl && isRuntimeFile(rel));
  const entries = new Map(); // Pfad -> Blob-Hash (bzw. Submodul-Commit)
  let staged = '';
  try { staged = gitZ(root, ['ls-files', '-s', '-z']); } catch { /* leeres Repo */ }
  for (const rec of staged.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t'); if (tab < 0) continue;
    const rel = rec.slice(tab + 1); const meta = rec.slice(0, tab).split(' ');
    if (!keep(rel)) continue;
    const stage = meta[2] || '0';
    entries.set(stage === '0' ? rel : rel + '#stage' + stage, meta[1]);
  }
  const need = new Set(); // Pfade, deren Arbeitsdatei frisch gehasht werden muss
  try { for (const f of gitZ(root, ['ls-files', '-m', '-z']).split('\0')) if (f && keep(f)) need.add(f); } catch { }
  try { for (const f of gitZ(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0')) if (f && keep(f)) need.add(f); } catch { }
  const hashable = [];
  for (const rel of need) {
    const abs = path.join(root, rel);
    let st = null; try { st = fs.lstatSync(abs); } catch { }
    if (!st) { entries.delete(rel); continue; }                       // geloescht
    if (st.isSymbolicLink()) {                                        // Git speichert den LINKTEXT als Blob, nicht das Ziel
      const t = Buffer.from(fs.readlinkSync(abs));
      entries.set(rel, crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + t.length + '\0'), t])).digest('hex'));
      continue;
    }
    if (st.isDirectory()) {                                           // Submodul: Commit statt Blob
      let sub = ''; try { sub = gitZ(abs, ['rev-parse', 'HEAD']).trim(); } catch { }
      entries.set(rel, 'gitlink:' + sub); continue;
    }
    if (rel.includes('\n')) { entries.set(rel, 'raw:' + crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex')); continue; }
    hashable.push(rel);
  }
  if (hashable.length) {
    const out = gitZ(root, ['hash-object', '--stdin-paths'], hashable.join('\n') + '\n').split('\n').filter(Boolean);
    if (out.length !== hashable.length) throw new Error('treeHash: hash-object lieferte ' + out.length + ' statt ' + hashable.length + ' Hashes');
    hashable.forEach((rel, i) => entries.set(rel, out[i]));
  }
  const h = crypto.createHash('sha1');
  for (const rel of [...entries.keys()].sort()) h.update(rel + '\0' + entries.get(rel) + '\n');
  return h.digest('hex');
}
// Bash-Schreibmuster-Regex: zentral hier definiert, damit write-recorder.js und
// role-tier-gate.js nicht driften (beide brauchten zuvor eine lokale Kopie).
const BASH_WRITE_PATTERN = /(>|>>|\bsed\s+-i|\btee\b|\bgit\s+apply\b|\bpatch\b|\bmv\b|\bcp\b|\brm\b|\bnpm\s+run\b)/;
// M7(b): Lese-Idiome (`2>&1`, `>/dev/null`, `2>/dev/null`) vor dem Musterabgleich
// entfernen — sie sind kein Schreiben in ein Repo. Ein Datei-Redirect bleibt Schreiben.
const READ_REDIRECTS = /\d*>&\d+|\d*>>?\s*\/dev\/null/g;
function isBashWrite(command) {
  return BASH_WRITE_PATTERN.test(String(command || '').replace(READ_REDIRECTS, ''));
}
function stateDir() { return process.env.CLAUDE_HARNESS_STATE || path.join(require('os').homedir(), '.claude', 'state'); }

// ---- Signierte Evidenz (Fix 19.09.2026): die Belegdatei allein reicht nicht — ein Agent koennte sie
// schreiben. Deshalb signiert checks-run den Beleg per HMAC ueber (root, treeHash, green) mit einem
// Maschinen-Secret; das Stop-Gate verwirft jeden Beleg ohne gueltige Signatur. Das schlaegt jede naive
// Faelschung (JSON mit green:true ohne Signatur). EHRLICHE GRENZE: das Secret liegt in einer Datei, die
// derselbe Nutzer (und damit der Agent) lesen/setzen kann — ein ENTSCHLOSSENER Agent koennte es lesen und
// mitsignieren. Die harte Durchsetzung fuer alle (auch einen solchen Agenten) leistet nur eine externe
// Instanz (CI auf GitHub). Der State-Guard schuetzt Secret + Beleg zusaetzlich gegen den direkten Schreibweg.
function gateSecretPath() { return path.join(stateDir(), '.gate-secret'); }
function gateSecret() {
  const f = gateSecretPath();
  try { const cur = fs.readFileSync(f, 'utf8').trim(); if (cur.length >= 32) return cur; } catch { /* fehlt/leer */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(stateDir(), { recursive: true }); try { fs.chmodSync(stateDir(), 0o700); } catch { }
    fs.writeFileSync(f, secret + '\n', { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch { }
  } catch { /* nicht schreibbar: HMAC bleibt konsistent innerhalb dieses Laufs */ }
  return secret;
}
function evidenceSig(root, treeHashHex, green) {
  return crypto.createHmac('sha256', gateSecret())
    .update(String(root) + '\0' + String(treeHashHex) + '\0' + (green ? '1' : '0')).digest('hex');
}
function evidenceValid(evd) {
  if (!evd || typeof evd.sig !== 'string' || typeof evd.root !== 'string' || typeof evd.treeHash !== 'string') return false;
  let a, b;
  try { a = Buffer.from(evd.sig, 'hex'); b = Buffer.from(evidenceSig(evd.root, evd.treeHash, !!evd.green), 'hex'); } catch { return false; }
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function safeMain(fn) {
  Promise.resolve()
    .then(fn)
    .catch((e) => { process.stderr.write(`[hook-fehler, fail-open] ${e.message}\n`); process.exit(0); });
}
module.exports = { readStdinJson, gitRoot, isCodeRepo, treeHash, stateDir, appendJsonl, safeMain, BASH_WRITE_PATTERN, isBashWrite, gateSecretPath, evidenceSig, evidenceValid };
