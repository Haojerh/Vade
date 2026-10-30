import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_SKILLS, readInstalledSkills } from '../workflow/skills.js';

function skill(root: string, name: string, content: string) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), content);
}

test('installed skills are read from bounded SKILL.md frontmatter only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-skills-'));
  try {
    skill(root, 'animate', '---\nname: animate\ndescription: Build an animation from scratch, deciding order.\n---\n\n# Animate\n');
    skill(root, 'block', '---\nname: block\ndescription: >\n  Keep web animations inside\n  the frame budget.\n---\nBody.\n');
    // No frontmatter: the first prose line becomes the description.
    skill(root, 'plain', '# Plain skill\n\nDo the plain thing well.\n');
    // Unreadable or unrelated entries never become references.
    fs.mkdirSync(path.join(root, 'empty'));
    fs.mkdirSync(path.join(root, 'bad name'));
    fs.writeFileSync(path.join(root, 'stray.md'), 'not a skill');
    const skills = readInstalledSkills(root);
    assert.deepEqual(skills.map(item => item.name), ['animate', 'block', 'plain']);
    assert.equal(skills[0]!.description, 'Build an animation from scratch, deciding order.');
    assert.equal(skills[1]!.description, 'Keep web animations inside the frame budget.');
    assert.equal(skills[2]!.description, 'Do the plain thing well.');
    assert.ok(skills.every(item => item.scope === 'personal'));
    // The recorded directory name wins over a mismatched frontmatter name.
    skill(root, 'dir-name', '---\nname: Not A Valid Name\ndescription: x\n---\n');
    assert.equal(readInstalledSkills(root).find(item => item.name === 'dir-name')?.description, 'x');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a missing skills directory and oversized or symlinked entries are empty, never fabricated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-skills-guard-'));
  try {
    assert.deepEqual(readInstalledSkills(path.join(root, 'absent')), []);
    skill(root, 'huge', `---\nname: huge\ndescription: ${'x'.repeat(70 * 1024)}\n---\n`);
    assert.deepEqual(readInstalledSkills(root), []);
    // A symlinked skill directory is not read.
    skill(root, 'real', '---\nname: real\ndescription: ok\n---\n');
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), 'dir');
      assert.deepEqual(readInstalledSkills(root).map(item => item.name), ['real']);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the installed skill list stays bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-skills-bound-'));
  try {
    for (let index = 0; index < MAX_SKILLS + 5; index++) {
      const name = `skill-${String(index).padStart(3, '0')}`;
      skill(root, name, `---\nname: ${name}\ndescription: bounded\n---\n`);
    }
    assert.equal(readInstalledSkills(root).length, MAX_SKILLS);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
