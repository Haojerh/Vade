// Native recognizer configuration follows Orca (MIT). See docs/licenses/orca-speech-LICENSE.txt.
// Run in an owned child process: a native inference failure must not stop ADE.
const path = require('node:path');
let sherpa, recognizer, stream, streaming, chunks = [], count = 0;
const rate = 16000;
function offline() {
  const audio = new Float32Array(count); let offset = 0;
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
  chunks = []; count = 0;
  if (!audio.length) return '';
  try {
    sherpa.acceptWaveformOffline(stream, { sampleRate: rate, samples: audio });
    sherpa.decodeOfflineStream(recognizer, stream);
    return JSON.parse(sherpa.getOfflineStreamResultAsJson(stream)).text?.trim() || '';
  } finally { stream = sherpa.createOfflineStream(recognizer); }
}
function online(finish) {
  if (finish) sherpa.inputFinished(stream);
  while (sherpa.isOnlineStreamReady(recognizer, stream)) sherpa.decodeOnlineStream(recognizer, stream);
  const text = JSON.parse(sherpa.getOnlineStreamResultAsJson(recognizer, stream)).text?.trim() || '';
  if (finish || sherpa.isEndpoint(recognizer, stream)) {
    if (finish) stream = sherpa.createOnlineStream(recognizer); else sherpa.reset(recognizer, stream);
    return { text, interim: '' };
  }
  return { text: '', interim: text };
}
process.on('message', message => {
  try {
    let result = { text: '', interim: '' };
    if (message.type === 'init') {
      sherpa = require(message.modulePath);
      const model = message.model, files = model.files;
      const file = (role, ext = '.onnx') => {
        const name = files.find(name => name.includes(role) && name.endsWith(ext));
        if (!name) throw Error('Missing model file'); return path.join(message.directory, name);
      };
      const modelConfig = { tokens: file('tokens', '.txt'), numThreads: 2, provider: 'cpu', debug: 0 };
      if (model.type === 'transducer') modelConfig.transducer = { encoder: file('encoder'), decoder: file('decoder'), joiner: file('joiner') };
      else if (model.type === 'paraformer' || model.type === 'whisper') modelConfig[model.type] = { encoder: file('encoder'), decoder: file('decoder') };
      else if (model.type === 'nemo-ctc') modelConfig.nemoCtc = { model: file('model') };
      else if (model.type === 'senseVoice') modelConfig.senseVoice = { model: file('model'), language: '', useInverseTextNormalization: 1 };
      const config = { featConfig: { sampleRate: rate, featureDim: 80 }, modelConfig, decodingMethod: 'greedy_search', enableEndpoint: 1, rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20 };
      streaming = model.streaming;
      recognizer = streaming ? sherpa.createOnlineRecognizer(config) : sherpa.createOfflineRecognizer(config);
      stream = streaming ? sherpa.createOnlineStream(recognizer) : sherpa.createOfflineStream(recognizer);
    } else if (message.type === 'audio') {
      const bytes = Buffer.from(message.pcm, 'base64');
      const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      if (streaming) { sherpa.acceptWaveformOnline(stream, { sampleRate: rate, samples }); result = online(false); }
      else { chunks.push(samples); count += samples.length; if (count >= rate * 8) result.text = offline(); }
    } else if (message.type === 'finish') result = streaming ? online(true) : { text: offline(), interim: '' };
    process.send?.({ id: message.id, result });
  } catch { process.send?.({ id: message.id, error: 'Local speech recognition failed. Try another model or restart dictation.' }); }
});
