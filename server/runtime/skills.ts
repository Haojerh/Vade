import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSkillSummary } from '../../shared/contracts.js';

/** Installed personal skills that the Chat composer may reference. Only direct skill
 *  directories with a bounded SKILL.md are read; nothing here is executed. */
export const MAX_SKILLS = 200;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_SKILL_DESCRIPTION = 240;
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function skillsDirectory(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

/** SKILL.md starts with a YAML frontmatter block; only `name` and `description` are read. */
function frontmatter(text: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!block) return {};
  const values: Record<string, string> = {};
  const lines = block[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[index]!);
    if (!match) continue;
    const key = match[1]!.toLowerCase(), inline = match[2]!.trim();
    // A block scalar (`>`/`|`) continues on the following indented lines.
    if (/^[>|][+-]?$/.test(inline)) {
      const parts: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) parts.push(lines[++index]!.trim());
      values[key] = parts.join(' ');
      continue;
    }
    values[key] = inline.replace(/^["']|["']$/g, '');
  }
  return values;
}

function clean(value: string, max: number): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** First readable sentence when the frontmatter carries no description. */
function fallbackDescription(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
    return clean(trimmed.replace(/^[-*]\s+/, ''), MAX_SKILL_DESCRIPTION);
  }
  return '';
}

function readSkill(directory: string, name: string): AgentSkillSummary | null {
  const file = path.join(directory, name, 'SKILL.md');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_FILE_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    const meta = frontmatter(text);
    const declared = meta.name && SKILL_NAME.test(meta.name) ? meta.name : name;
    return { name: declared, description: clean(meta.description ?? '', MAX_SKILL_DESCRIPTION) || fallbackDescription(text), scope: 'personal' };
  } catch { return null; }
}

/** Installed skills ordered by name. A missing skills directory is an empty list, not a failure. */
export function readInstalledSkills(directory = skillsDirectory()): AgentSkillSummary[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
  const skills: AgentSkillSummary[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (skills.length >= MAX_SKILLS) break;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SKILL_NAME.test(entry.name)) continue;
    const skill = readSkill(directory, entry.name);
    if (skill) skills.push(skill);
  }
  return skills;
}
