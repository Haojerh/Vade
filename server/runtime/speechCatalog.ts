import { getSpeechModelDownloadMetadata, type DownloadableSpeechModelId } from './speechModelDownloads.js';

export const speechModels = [
  ['parakeet-tdt-0.6b-v3-int8', 'Parakeet TDT v3', '25 European languages. Punctuation and capitalization.', 'transducer', false, true],
  ['parakeet-tdt-0.6b-v2-int8', 'Parakeet TDT v2', 'English. Punctuation and capitalization.', 'transducer', false],
  ['zipformer-bilingual-zh-en', 'Zipformer Bilingual', 'Chinese + English with code switching.', 'transducer', true],
  ['paraformer-bilingual-zh-en', 'Paraformer Bilingual', 'Mandarin, regional Chinese and English.', 'paraformer', true],
  ['zipformer-streaming-en-20m', 'Zipformer Streaming EN', 'Lightweight English streaming model.', 'transducer', true],
  ['zipformer-streaming-zh-14m', 'Zipformer Streaming ZH', 'Lightweight Chinese streaming model.', 'transducer', true],
  ['zipformer-streaming-korean', 'Zipformer Streaming KO', 'Korean streaming model.', 'transducer', true],
  ['parakeet-tdt-ctc-0.6b-ja-int8', 'Parakeet TDT-CTC JA', 'Japanese with punctuation.', 'nemo-ctc', false],
  ['whisper-tiny', 'Whisper Tiny', '90+ languages. Broad language coverage.', 'whisper', false],
  ['sense-voice-zh-en-ja-ko-yue', 'SenseVoice', 'Chinese, English, Japanese, Korean and Cantonese.', 'senseVoice', false],
].map(row => {
  const [id, label, description, type, streaming, recommended] = row as [DownloadableSpeechModelId, string, string, string, boolean, boolean?];
  return { id, label, description, type, streaming, recommended, ...getSpeechModelDownloadMetadata(id) };
});
