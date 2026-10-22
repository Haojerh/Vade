const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  const command = ['--yes', 'skills@1.7.4', 'add', skills, '--skill', 'vade-cli', 'vade-orchestration', '--global', '--agent', 'codex', 'claude-code', 'antigravity', '--yes'];
  console.log('Installing both skills with npx skills@1.7.4 into standard agent directories.');
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& npx.cmd ${command.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`], { stdio: 'inherit', windowsHide: true, timeout: 180000 })
    : spawnSync('npx', command, { stdio: 'inherit', timeout: 180000 });
  if (result.error || result.status !== 0) throw new Error('Skill installation failed. Check Node.js, npx and network access, then run setup again.');
  for (const name of ['vade.cjs', 'SKILL.md', 'cli-SKILL.md']) {
    const bytes = fs.readFileSync(path.join(__dirname, name));
    if (bytes.length > 262144) throw new Error('Invalid bundled component');
    const temp = path.join(destination, `${name}.tmp`);
    fs.writeFileSync(temp, bytes, { mode: 0o600 }); fs.renameSync(temp, path.join(destination, name));
    console.log(`Installed ${name}`);
  }
  console.log('Vade orchestration components are up to date. Return to Settings and re-check.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
