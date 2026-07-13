# Codex Handoff: Live WebGPU Speech-to-Text

## Goal

Take over this Next.js project and implement a reliable browser-based live speech-to-text prototype.

The user originally wanted NVIDIA Parakeet running in the browser through WebGPU so the application can remain permanently free and avoid a separate GPU server.

The immediate priority is to produce a working end-to-end browser transcription pipeline. It is acceptable to validate the architecture with Whisper Tiny first, then replace it with a compatible Parakeet model.

## Current project shape

The repository was created with Next.js App Router and does not use a `src/` directory.

Expected structure:

```text
project-root/
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── public/
├── workers/
│   └── transcriber.worker.ts
├── package.json
└── tsconfig.json
```

The `workers/` directory may not exist yet.

## What has been discussed but not verified

A proposed implementation was described with:

- `app/page.tsx` as the live recording UI
- `workers/transcriber.worker.ts` for model loading and inference
- automatic model prefetch on initial page load
- browser Cache API use through Transformers.js
- 3-second PCM audio chunks
- a transcription queue inside the worker
- WebGPU detection using `"gpu" in navigator`
- microphone input using the Web Audio API
- a temporary `ScriptProcessorNode`

Treat all of this as design context, not as confirmed working code. Inspect the repository before modifying anything.

## Desired user experience

1. User opens the page.
2. The app detects whether WebGPU is available.
3. The speech model starts downloading and initialising immediately.
4. The page displays model progress and readiness.
5. User presses **Start recording**.
6. Browser requests microphone permission.
7. User speaks normally.
8. Text appears incrementally with low perceived delay.
9. User presses **Stop recording**.
10. Remaining buffered audio is transcribed.
11. User can copy or clear the transcript.
12. On later visits, cached model assets reduce startup time.

## Architecture

```text
Microphone
    ↓
AudioWorklet or temporary ScriptProcessorNode
    ↓
Mono PCM audio
    ↓
Resample to 16 kHz
    ↓
Web Worker
    ↓
WebGPU ASR model
    ↓
Partial/final chunk results
    ↓
React UI
```

Model inference must remain client-side.

## Recommended implementation order

### Phase 1: inspect and stabilise

- Inspect `package.json`, `tsconfig.json`, `app/page.tsx` and existing files.
- Confirm the installed Next.js version.
- Confirm whether `@huggingface/transformers` is installed.
- Run the existing application before editing.
- Preserve useful existing code where possible.

### Phase 2: prove WebGPU inference

- Add a dedicated module Web Worker.
- Load `onnx-community/whisper-tiny.en` through `@huggingface/transformers`.
- Use `device: "webgpu"`.
- Choose a supported dtype based on the installed Transformers.js version.
- Send a test audio buffer to the worker.
- Confirm transcription works before building live recording.

### Phase 3: live microphone flow

- Capture mono microphone audio.
- Prefer an `AudioWorklet`.
- Resample to 16 kHz.
- Buffer approximately 2 to 4 seconds per chunk.
- Queue chunks in the worker so only one inference call runs at a time.
- Flush the final partial chunk when recording stops.
- Prevent unbounded backlog if inference is slower than real time.

### Phase 4: transcript quality

Chunked non-streaming ASR can cut words at boundaries. Improve this by:

- adding a short overlap between chunks
- deduplicating overlapping words
- using voice activity detection where useful
- separating temporary and committed transcript text
- discarding near-silent chunks

Avoid naive concatenation if it produces repeated phrases.

### Phase 5: Parakeet investigation

Investigate a browser-compatible Parakeet ONNX model.

Before integrating it, verify:

- whether it works with standard Transformers.js
- whether custom model code is required
- supported WebGPU operators
- model download size
- quantised variants
- memory use
- expected sample rate
- decoder requirements
- whether true streaming is supported

Keep the worker interface stable so the model backend can be swapped without rewriting the UI.

### Phase 6: polish and deployment

- Add clear unsupported-browser messaging.
- Add permission-denied handling.
- Add loading and inference status.
- Add recording timer.
- Add copy and clear controls.
- Ensure cleanup of tracks, AudioContext, AudioWorklet and worker.
- Run lint and production build.
- Verify deployment compatibility with Vercel.

## Worker message contract

A suggested message protocol:

### Page to worker

```ts
type WorkerRequest =
  | { type: "load" }
  | { type: "transcribe"; id: string; audio: Float32Array }
  | { type: "reset" };
```

### Worker to page

```ts
type WorkerResponse =
  | {
      type: "status";
      status: "loading" | "ready" | "transcribing";
      message: string;
    }
  | {
      type: "progress";
      file?: string;
      progress?: number;
      loaded?: number;
      total?: number;
    }
  | {
      type: "result";
      id: string;
      text: string;
      durationMs: number;
    }
  | {
      type: "error";
      message: string;
    };
```

Use chunk IDs so results can be tracked and ordered safely.

## Performance considerations

- Do not initialise the model for every chunk.
- Load it once and retain it inside the worker.
- Transfer `ArrayBuffer` ownership when posting audio.
- Avoid repeatedly copying large audio arrays.
- Monitor queue size.
- If the queue grows too large, merge or drop stale partial chunks rather than allowing memory growth.
- Avoid very small chunks because accuracy drops and overhead rises.
- Avoid very large chunks because visible latency rises.
- Start with 3 seconds and tune from actual measurements.
- Display actual inference duration during development.
- Test after the model is cached and on a fresh browser profile.

## Browser constraints

- WebGPU availability depends on browser, OS, GPU and hardware acceleration.
- Test primarily on current Chrome or Edge.
- `localhost` and HTTPS are required for microphone access in normal browser conditions.
- Vercel HTTPS is suitable.
- Browser tabs may be throttled when backgrounded.
- Large models may fail on low-memory devices.

## Files Codex should probably create or modify

```text
app/page.tsx
workers/transcriber.worker.ts
public/audio-processor.js        # if using a plain AudioWorklet module
lib/audio.ts                     # optional audio helpers
types/webgpu.d.ts                # only if TypeScript needs WebGPU declarations
```

Codex may choose a different clean structure.

## Validation checklist

- [ ] `npm install` succeeds
- [ ] `npm run dev` starts
- [ ] page renders without hydration errors
- [ ] worker bundles correctly
- [ ] WebGPU detection works
- [ ] model loads automatically
- [ ] repeated visit uses cached assets where supported
- [ ] microphone permission flow works
- [ ] live audio reaches worker
- [ ] transcript returns
- [ ] chunk processing is serialised
- [ ] stopping recording flushes final audio
- [ ] recording can restart
- [ ] resources are cleaned up
- [ ] unsupported state is readable
- [ ] `npm run lint` passes
- [ ] `npm run build` passes

## Final reporting requested from Codex

When finished, provide:

1. Summary of what was implemented.
2. Exact files changed.
3. Commands run and their results.
4. Current model being used.
5. Whether Parakeet was integrated or remains a follow-up.
6. Known limitations.
7. Suggested next improvements.
