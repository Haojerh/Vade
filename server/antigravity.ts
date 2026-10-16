import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Verified against agy's bundled cortex.proto descriptors (2026-10-16):
// CortexStepGeneratorMetadata.planner_config = 3;
// CascadePlannerConfig.model_name = 28;
// CortexStepGeneratorMetadata.chat_model = 1;
// ChatModelMetadata.response_model = 19.
// Read only these fields; never search prompt/tool text for model names.
function protobufField(bytes: Uint8Array, field: number): Uint8Array | null {
  let offset = 0;
  let value: Uint8Array | null = null;
  const varint = () => {
    let result = 0;
    let shift = 0;
    while (offset < bytes.length && shift < 56) {
      const byte = bytes[offset++];
      result += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) {
        if (!Number.isSafeInteger(result)) throw new Error('Invalid protobuf integer');
        return result;
      }
      shift += 7;
    }
    throw new Error('Invalid protobuf varint');
  };
  while (offset < bytes.length) {
    const tag = varint();
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number < 1) throw new Error('Invalid protobuf field');
    if (wire === 0) {
      varint();
    } else if (wire === 2) {
      const size = varint();
      if (offset + size > bytes.length) throw new Error('Invalid protobuf length');
      if (number === field) value = bytes.subarray(offset, offset + size);
      offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('Invalid protobuf fixed field');
    } else {
      throw new Error('Unsupported protobuf wire type');
    }
  }
  return value;
}

export function readAntigravityModel(
  conversationId: string,
  isAllowedPath: (file: string) => boolean
): { model: string; effort: string | null } | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
  const base = process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity-cli');
  const file = path.join(base, 'conversations', `${conversationId}.db`);
  if (!fs.existsSync(file) || !isAllowedPath(file)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare('SELECT cascade_id FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(conversationId)) return null;
    const row = db.prepare(`
      SELECT CASE WHEN length(data) <= 2097152 THEN data ELSE NULL END AS data
      FROM gen_metadata ORDER BY idx DESC LIMIT 1
    `).get() as { data: Uint8Array | null } | undefined;
    if (!row?.data) return null;
    const planner = protobufField(row.data, 3);
    const modelBytes = planner ? protobufField(planner, 28) : null;
    const chat = modelBytes ? null : protobufField(row.data, 1);
    const responseBytes = chat ? protobufField(chat, 19) : null;
    const model = Buffer.from(modelBytes ?? responseBytes ?? []).toString('utf8').trim();
    if (!model || model.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) return null;
    // Antigravity's model list uses explicit effort presets in these IDs.
    const preset = modelBytes ? model.match(/^((?:gemini-|claude-|gpt-oss-).+)-(low|medium|high|xhigh|max)$/) : null;
    return preset ? { model: preset[1], effort: preset[2] } : { model, effort: null };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
