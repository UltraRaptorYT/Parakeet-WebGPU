import {
  env,
  pipeline,
  type AllTasks,
  type ProgressInfo,
} from "@huggingface/transformers";

const MODEL_ID = "onnx-community/whisper-tiny.en";
const MAX_QUEUED_CHUNKS = 3;

env.allowLocalModels = false;
env.useBrowserCache = true;

type WorkerRequest =
  | { type: "load" }
  | {
      type: "transcribe";
      id: string;
      sessionId: number;
      audio: Float32Array;
    }
  | { type: "reset"; sessionId: number };

type QueueItem = Extract<WorkerRequest, { type: "transcribe" }>;
type Transcriber = AllTasks["automatic-speech-recognition"];

let transcriber: Transcriber | null = null;
let loadPromise: Promise<Transcriber> | null = null;
let processing = false;
const queue: QueueItem[] = [];

function postStatus(
  status: "loading" | "ready" | "transcribing",
  message: string,
) {
  self.postMessage({
    type: "status",
    status,
    message,
    queueDepth: queue.length,
  });
}

async function loadModel(): Promise<Transcriber> {
  if (transcriber) {
    return transcriber;
  }

  if (loadPromise) {
    return loadPromise;
  }

  postStatus("loading", "Downloading and initialising Whisper Tiny...");

  loadPromise = pipeline("automatic-speech-recognition", MODEL_ID, {
    device: "webgpu",
    dtype: "q4",
    progress_callback: (progress: ProgressInfo) => {
      self.postMessage({ type: "progress", progress });
    },
  });

  try {
    transcriber = await loadPromise;
    postStatus("ready", "Model ready");
    return transcriber;
  } catch (error) {
    loadPromise = null;
    throw error;
  }
}

async function processQueue() {
  if (processing) {
    return;
  }

  processing = true;

  let model: Transcriber;

  try {
    model = await loadModel();
  } catch (error) {
    const message = getErrorMessage(error, "Failed to load the speech model.");

    while (queue.length > 0) {
      const item = queue.shift();

      if (item) {
        self.postMessage({
          type: "error",
          id: item.id,
          sessionId: item.sessionId,
          message,
          fatal: true,
          queueDepth: queue.length,
        });
      }
    }

    processing = false;
    return;
  }

  while (queue.length > 0) {
    const item = queue.shift();

    if (!item) {
      continue;
    }

    postStatus("transcribing", "Transcribing live audio...");
    const startedAt = performance.now();

    try {
      // whisper-tiny.en ships the correct English-only generation config.
      // Multilingual language/task tokens are not available for this model.
      const output = await model(item.audio, {
        is_multilingual: false,
        return_timestamps: true,
      });

      const text = Array.isArray(output)
        ? output
            .map((result) => result.text)
            .join(" ")
            .trim()
        : output.text.trim();

      self.postMessage({
        type: "result",
        id: item.id,
        sessionId: item.sessionId,
        text,
        durationMs: Math.round(performance.now() - startedAt),
        queueDepth: queue.length,
      });
    } catch (error) {
      self.postMessage({
        type: "error",
        id: item.id,
        sessionId: item.sessionId,
        message: getErrorMessage(
          error,
          "Could not transcribe this audio chunk.",
        ),
        fatal: false,
        queueDepth: queue.length,
      });
    }
  }

  processing = false;
  postStatus("ready", "Model ready");
}

function enqueue(item: QueueItem) {
  if (queue.length >= MAX_QUEUED_CHUNKS) {
    const dropped = queue.shift();

    if (dropped) {
      self.postMessage({
        type: "dropped",
        id: dropped.id,
        sessionId: dropped.sessionId,
        message: "An older audio chunk was skipped to keep transcription live.",
        queueDepth: queue.length,
      });
    }
  }

  queue.push(item);
  void processQueue();
}

function resetQueue(sessionId: number) {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index];

    if (item.sessionId !== sessionId) {
      queue.splice(index, 1);
      self.postMessage({
        type: "dropped",
        id: item.id,
        sessionId: item.sessionId,
        message: "Queued audio was cleared.",
        queueDepth: queue.length,
      });
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.type === "load") {
    void loadModel().catch((error: unknown) => {
      self.postMessage({
        type: "error",
        message: getErrorMessage(error, "Failed to load the speech model."),
        fatal: true,
        queueDepth: queue.length,
      });
    });
    return;
  }

  if (request.type === "reset") {
    resetQueue(request.sessionId);
    return;
  }

  enqueue(request);
};

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
