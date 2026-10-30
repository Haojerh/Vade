const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

/** skills@1.7.4 links the Antigravity agent into ~/.gemini/antigravity/skills, but the
 *  Antigravity CLI reads ~/.gemini/config/skills. Mirror the two skills into the directory
 *  Antigravity actually loads when its config root exists. Never replace an existing entry. */
function linkAntigravitySkills() {
  const config = path.join(os.homedir(), '.gemini', 'config');
  if (!fs.existsSync(config)) return;
  const target = path.join(config, 'skills');
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['vade-cli', 'vade-orchestration']) {
    const source = path.join(os.homedir(), '.agents', 'skills', name);
    const link = path.join(target, name);
    if (!fs.existsSync(source)) continue;
    try { fs.lstatSync(link); continue; } catch { /* Not present yet. */ }
    try { fs.symlinkSync(source, link, 'junction'); }
    catch { try { fs.cpSync(source, link, { recursive: true }); } catch { /* Leave the skill unlinked. */ } }
  }
  console.log(`Linked both skills for Antigravity in ${target}`);
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--data-dir' || !path.isAbsolute(args[1])) throw new Error('Expected --data-dir with the Vade data directory');
  const destination = path.join(args[1], 'orchestration');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const skills = path.join(__dirname, 'skills');
  for (const [name, source] of [['vade-cli', 'cli-SKILL.md'], ['vade-orchestration', 'SKILL.md']]) {
    const directory = path.join(skills, name); fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(path.join(__dirname, source), path.join(directory, 'SKILL.md'));
  }
  // The official installer owns canonical skill placement and provider links.
  const command = ['--yes', 'skills@1.7.4', 'add', skills, '--skill', 'vade-cli', 'vade-orchestration', '--global', '--agent', 'codex', 'claude-code', 'antigravity', 'codebuddy', 'opencode', 'kilo', '--yes'];
  console.log('Installing both skills with npx skills@1.7.4 into standard agent directories.');
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& npx.cmd ${command.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`], { stdio: 'inherit', windowsHide: true, timeout: 180000 })
    : spawnSync('npx', command, { stdio: 'inherit', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error('Skill installation failed. Check Node.js, npx and network access, then run setup again.');
  linkAntigravitySkills();
  for (const name of ['vade.cjs', 'SKILL.md', 'cli-SKILL.md']) {
    const bytes = fs.readFileSync(path.join(__dirname, name));
    if (bytes.length > 262144) throw new Error('Invalid bundled component');
    const temp = path.join(destination, `${name}.tmp`);
    fs.writeFileSync(temp, bytes, { mode: 0o600 }); fs.renameSync(temp, path.join(destination, name));
    console.log(`Installed ${name}`);
  }
  console.log('Vade orchestration components are up to date. Return to Settings and re-check.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
