import type { AgentChatModel, WorkflowModel } from '../../../shared/contracts.js';

export const FREEBUFF_MODELS: AgentChatModel[] = [
  // Optimized
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash (Recommended)', efforts: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
  { id: 'm-8db1ccbba6', label: 'GLM 5.3 Flash (Default)', efforts: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', efforts: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
  { id: 'mimo/mimo-v2.5', label: 'Mimo V2.5', efforts: [] },
  { id: 'meta/muse-spark-1.3-contributor', label: 'Muse Spark 1.3', efforts: [{ value: 'high', label: 'High' }] },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', efforts: [{ value: 'high', label: 'High' }] },
  // Unlimited
  { id: 'm-ddc687c50f', label: 'M-DDC6 (Unlimited)', efforts: [] },
  { id: 'm-02244092cb', label: 'M-0224 (Unlimited)', efforts: [] },
  { id: 'upstage/solar-pro4', label: 'Solar Pro 4', efforts: [] },
  { id: 'upstage/solar-mini4', label: 'Solar Mini 4', efforts: [] },
  // Powerful
  { id: 'mimo/mimo-v2.6-pro', label: 'Mimo V2.6 Pro', efforts: [] },
  { id: 'deepseek/deepseek-v4-flash-fast', label: 'DeepSeek V4 Flash Fast', efforts: [] },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'XHigh' }] },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: [] },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', efforts: [{ value: 'medium', label: 'Medium' }] },
  { id: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: [{ value: 'medium', label: 'Medium' }] },
];

export function freebuffWorkflowModels(): WorkflowModel[] {
  return FREEBUFF_MODELS.map(m => ({
    id: m.id,
    label: m.label,
    efforts: m.efforts.map(e => e.value),
    contextWindow: 1_000_000,
  }));
}
