import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findClaudeTranscript(
  labelOrId: string,
  allowed?: (file: string) => boolean
): { transcriptPath: string; sessionId: string } | null {
  const claudeDir = path.join(os.homedir(), '.claude');
  const clean = labelOrId.replace(/^✳\s*/, '').replace(/^Claude(?:\s+Code)?\s*\|\s*/i, '').split(/\s*\|\s*/)[0].trim();

  // 1. Check Orca AI vault cache
  try {
    const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
    const vaultCache = path.join(appData, 'orca', 'ai-vault', 'session-parse-cache.json');
    if (fs.existsSync(vaultCache)) {
      const data = JSON.parse(fs.readFileSync(vaultCache, 'utf-8'));
      const entries = Array.isArray(data.entries) ? data.entries : [];
      for (const [, val] of entries) {
        const s = val?.session;
        if (s && s.agent === 'claude') {
          const matchTitle = s.title && clean && (s.title.toLowerCase() === clean.toLowerCase() || clean.toLowerCase().includes(s.title.toLowerCase()) || s.title.toLowerCase().includes(clean.toLowerCase()));
          const matchId = s.sessionId && (s.sessionId === clean || labelOrId.includes(s.sessionId));
          if ((matchTitle || matchId) && s.filePath && fs.existsSync(s.filePath) && (!allowed || allowed(s.filePath))) {
            return { transcriptPath: s.filePath, sessionId: s.sessionId };
          }
        }
      }
    }
  } catch {}

  if (!fs.existsSync(claudeDir)) return null;
  const uuidMatch = labelOrId.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  const projectsDir = path.join(claudeDir, 'projects');
  if (uuidMatch && fs.existsSync(projectsDir)) {
    const id = uuidMatch[0];
    for (const p of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, p, `${id}.jsonl`);
      if (fs.existsSync(candidate) && (!allowed || allowed(candidate))) {
        return { transcriptPath: candidate, sessionId: id };
      }
    }
  }
  if (!clean || ['claude', 'claude code', 'agent'].includes(clean.toLowerCase())) return null;
  const hPath = path.join(claudeDir, 'history.jsonl');
  if (fs.existsSync(hPath) && fs.existsSync(projectsDir)) {
    try {
      const lines = fs.readFileSync(hPath, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
        const item = JSON.parse(lines[i]);
        if (item.sessionId && item.display && item.display.toLowerCase().includes(clean.toLowerCase())) {
          for (const p of fs.readdirSync(projectsDir)) {
            const candidate = path.join(projectsDir, p, `${item.sessionId}.jsonl`);
            if (fs.existsSync(candidate) && (!allowed || allowed(candidate))) {
              return { transcriptPath: candidate, sessionId: item.sessionId };
            }
          }
        }
      }
    } catch {}
  }
  return null;
}
