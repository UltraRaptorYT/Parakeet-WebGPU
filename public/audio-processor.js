/* global AudioWorkletProcessor, registerProcessor */

const BATCH_SIZE = 2_048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.buffer = new Float32Array(BATCH_SIZE);
    this.offset = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.emitBuffer();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  process(inputs) {
    const channels = inputs[0];

    if (!channels || channels.length === 0) {
      return true;
    }

    const frameCount = channels[0].length;

    for (let frame = 0; frame < frameCount; frame += 1) {
      let sample = 0;

      for (const channel of channels) {
        sample += channel[frame] / channels.length;
      }

      this.buffer[this.offset] = sample;
      this.offset += 1;

      if (this.offset === this.buffer.length) {
        this.emitBuffer();
      }
    }

    return true;
  }

  emitBuffer() {
    if (this.offset === 0) {
      return;
    }

    const audio = this.buffer.slice(0, this.offset);
    this.port.postMessage(audio, [audio.buffer]);
    this.offset = 0;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
