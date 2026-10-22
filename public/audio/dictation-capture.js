// Capture only; recognition runs in the local backend. No audio leaves ADE.
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(4096); this.offset = 0;
    this.port.onmessage = event => {
      if (event.data !== 'flush') return;
      if (this.offset) this.port.postMessage(this.samples.slice(0, this.offset));
      this.offset = 0; this.port.postMessage({ flushed: true });
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.samples[this.offset++] = value / channels.length;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(4096); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('ade-dictation-capture', DictationCapture);
