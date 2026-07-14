# Live WebGPU transcription

A client-side live speech-to-text proof of concept built with Next.js App
Router, Transformers.js, an AudioWorklet, and WebGPU.

Microphone audio remains in the browser. The page captures mono PCM, sends
overlapping chunks to a module Web Worker, and runs inference there so model
work does not block the React UI.

## Requirements

- A current Chrome or Edge release with WebGPU and hardware acceleration
- `localhost` or HTTPS for microphone access
- Node.js and npm

## Run locally

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. The model starts downloading and initialising as
soon as WebGPU support is confirmed. Model assets are cached with the browser
Cache API when available.

## Verification

```bash
npm run lint
npm run build
```

## Current model

The MVP uses multilingual `onnx-community/whisper-base` with WebGPU and q4 ONNX
weights. The page supplies the selected spoken-language code explicitly because
this Transformers.js version does not automatically detect Whisper languages.
The worker contract and audio path remain model-agnostic so a verified
browser-compatible Parakeet ONNX conversion can replace it later.

## Architecture

```text
Microphone
  -> AudioWorklet (mono PCM)
  -> 3-second chunks with overlap
  -> 16 kHz resampling
  -> bounded Web Worker queue
  -> Transformers.js / WebGPU
  -> ordered transcript results
```

The worker serialises inference calls and bounds its waiting queue to prevent a
slow GPU from creating an unlimited audio backlog. Near-silent chunks are
discarded, and repeated words at overlapping chunk boundaries are deduplicated
before display.

## Known limitations

- Chunked Whisper ASR is not true streaming and mixed-language speech within a
  single chunk is not automatically detected.
- Accuracy and latency vary significantly by GPU and microphone quality.
- An overloaded worker may skip an older queued chunk to remain live; the UI
  reports when this happens.
- Parakeet is not integrated until a conversion is verified against standard
  Transformers.js, WebGPU operators, memory limits, and decoder requirements.
