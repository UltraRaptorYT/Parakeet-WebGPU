<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

## Project

Browser-based live speech-to-text proof of concept using Next.js App Router and WebGPU.

## Repository assumptions

- Next.js App Router
- No `src/` directory
- Main page: `app/page.tsx`
- Web Worker: `workers/transcriber.worker.ts`
- Package manager: npm
- Intended deployment target: Vercel
- Speech inference should run locally in the browser, not in a Vercel Function

## Primary objective

Build a working live microphone transcription experience that:

1. Detects WebGPU support.
2. Prefetches and initialises the model when the page opens.
3. Records microphone audio continuously.
4. Converts audio to mono 16 kHz PCM.
5. Sends short chunks to a Web Worker.
6. Runs speech-to-text inference without blocking the UI.
7. Appends transcript results while recording.
8. Caches model files in the browser for later visits.
9. Works locally with `npm run dev`.
10. Can be deployed as a static/client-heavy Next.js application on Vercel.

## Important implementation constraints

- Do not run model inference in Next.js API routes or Vercel Functions.
- Keep model loading and inference inside a browser Web Worker.
- Do not freeze the React main thread.
- Prefer `AudioWorklet` for the final implementation.
- `ScriptProcessorNode` may be used temporarily only as an MVP fallback.
- Avoid sending private audio to any remote API.
- Do not expose secrets in the browser.
- Handle unsupported WebGPU cleanly.
- Handle microphone denial and model-loading errors.
- Keep TypeScript strict and avoid `any` unless unavoidable.
- Run lint and build checks before considering the task complete.

## Model strategy

Start by verifying the complete browser pipeline with a known Transformers.js-compatible WebGPU ASR model.

Suggested validation model:

- `onnx-community/whisper-tiny.en`

Target model:

- A browser-compatible Parakeet ONNX/WebGPU conversion

Do not assume that an arbitrary Hugging Face Parakeet repository works directly with the standard `@huggingface/transformers` package. Inspect its model card, required runtime, custom code and ONNX graph compatibility before swapping models.

The architecture should make model replacement easy.

## Expected commands

```bash
npm install
npm run dev
npm run lint
npm run build
```

## Definition of done

- The page opens without runtime errors.
- The model begins loading automatically.
- Progress or a clear loading state is shown.
- A user can grant microphone access and start recording.
- Transcript text appears during or shortly after speech.
- Recording can be stopped and restarted.
- The transcript can be cleared and copied.
- Repeated audio chunks do not start concurrent model calls.
- No duplicate worker or microphone resources remain after unmount.
- `npm run lint` passes.
- `npm run build` passes.


<!-- END:nextjs-agent-rules -->
