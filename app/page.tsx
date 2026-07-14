"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  appendTranscript,
  calculateRms,
  mergeAudioChunks,
  resampleAudio,
  TARGET_SAMPLE_RATE,
} from "@/lib/audio";

type ModelStatus =
  | "checking"
  | "unsupported"
  | "loading"
  | "ready"
  | "error";

type WorkerMessage =
  | {
      type: "status";
      status: "loading" | "ready" | "transcribing";
      message: string;
      queueDepth: number;
    }
  | { type: "progress"; progress: unknown }
  | {
      type: "result";
      id: string;
      sessionId: number;
      text: string;
      durationMs: number;
      queueDepth: number;
    }
  | {
      type: "dropped";
      id: string;
      sessionId: number;
      message: string;
      queueDepth: number;
    }
  | {
      type: "error";
      id?: string;
      sessionId?: number;
      message: string;
      fatal: boolean;
      queueDepth: number;
    };

type WorkletMessage = Float32Array | { type: "flushed" };

const CHUNK_SECONDS = 3;
const OVERLAP_SECONDS = 0.4;
const SILENCE_RMS_THRESHOLD = 0.0015;
const LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "zh", label: "Chinese" },
  { code: "ms", label: "Malay" },
  { code: "ta", label: "Tamil" },
  { code: "id", label: "Indonesian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "th", label: "Thai" },
  { code: "vi", label: "Vietnamese" },
  { code: "hi", label: "Hindi" },
  { code: "ar", label: "Arabic" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ru", label: "Russian" },
  { code: "tr", label: "Turkish" },
  { code: "tl", label: "Filipino" },
] as const;

type LanguageCode = (typeof LANGUAGE_OPTIONS)[number]["code"];

export default function Home() {
  const workerRef = useRef<Worker | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioChunksRef = useRef<Float32Array[]>([]);
  const bufferedSamplesRef = useRef(0);
  const freshSamplesRef = useRef(0);
  const isRecordingRef = useRef(false);
  const pendingChunksRef = useRef(0);
  const sessionIdRef = useRef(0);
  const chunkSequenceRef = useRef(0);
  const languageRef = useRef<LanguageCode>("en");
  const workletFlushResolverRef = useRef<(() => void) | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [modelStatus, setModelStatus] = useState<ModelStatus>("checking");
  const [message, setMessage] = useState("Checking WebGPU support...");
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [transcript, setTranscript] = useState("");
  const [secondsRecorded, setSecondsRecorded] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isWorkerBusy, setIsWorkerBusy] = useState(false);
  const [pendingChunks, setPendingChunks] = useState(0);
  const [lastInferenceMs, setLastInferenceMs] = useState<number | null>(null);
  const [userError, setUserError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] =
    useState<LanguageCode>("en");

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | null = null;

    async function initialise() {
      const support = await detectWebGpuSupport();

      if (cancelled) {
        return;
      }

      if (!support.supported) {
        setModelStatus("unsupported");
        setMessage(support.message);
        return;
      }

      setModelStatus("loading");
      setMessage("Starting the transcription worker...");

      try {
        worker = new Worker(
          new URL("../workers/transcriber.worker.ts", import.meta.url),
          { type: "module" },
        );
      } catch (error) {
        setModelStatus("error");
        setMessage("The transcription worker could not be started.");
        setUserError(
          error instanceof Error
            ? error.message
            : "The transcription worker could not be started.",
        );
        return;
      }

      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        if (cancelled) {
          return;
        }

        const data = event.data;

        if (data.type === "status") {
          if (data.status === "loading") {
            setModelStatus("loading");
            setMessage(data.message);
          } else if (data.status === "transcribing") {
            setIsWorkerBusy(true);
            setMessage(
              isRecordingRef.current
                ? "Listening and transcribing..."
                : "Finishing transcription...",
            );
          } else {
            setModelStatus("ready");
            setIsWorkerBusy(false);
            setMessage(
              isRecordingRef.current
                ? "Listening..."
                : pendingChunksRef.current > 0
                  ? "Finishing transcription..."
                  : "Model ready",
            );
          }
          return;
        }

        if (data.type === "progress") {
          const progress = getDownloadPercentage(data.progress);

          if (progress !== null) {
            setDownloadProgress(progress);
            setMessage(`Downloading model: ${progress}%`);
          }
          return;
        }

        if (data.type === "result") {
          pendingChunksRef.current = Math.max(
            0,
            pendingChunksRef.current - 1,
          );
          setPendingChunks(pendingChunksRef.current);
          setLastInferenceMs(data.durationMs);

          if (data.sessionId === sessionIdRef.current && data.text.trim()) {
            setTranscript((current) => appendTranscript(current, data.text));
          }
          return;
        }

        if (data.type === "dropped") {
          pendingChunksRef.current = Math.max(
            0,
            pendingChunksRef.current - 1,
          );
          setPendingChunks(pendingChunksRef.current);

          if (data.sessionId === sessionIdRef.current) {
            setNotice(data.message);
          }
          return;
        }

        if (data.id) {
          pendingChunksRef.current = Math.max(
            0,
            pendingChunksRef.current - 1,
          );
          setPendingChunks(pendingChunksRef.current);
        }

        setIsWorkerBusy(false);

        if (data.fatal) {
          setModelStatus("error");
          setMessage("The speech model could not be loaded.");
        }

        setUserError(data.message);
      };

      worker.onerror = (event) => {
        if (cancelled) {
          return;
        }

        setIsWorkerBusy(false);
        setModelStatus("error");
        setMessage("The transcription worker failed.");
        setUserError(event.message || "The transcription worker failed.");
      };

      workerRef.current = worker;
      worker.postMessage({ type: "load" });
    }

    void initialise();

    return () => {
      cancelled = true;
      isRecordingRef.current = false;

      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }

      workletFlushResolverRef.current?.();
      workletFlushResolverRef.current = null;

      if (workletNodeRef.current) {
        workletNodeRef.current.port.onmessage = null;
        workletNodeRef.current.disconnect();
      }

      sourceNodeRef.current?.disconnect();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());

      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        void audioContextRef.current.close();
      }

      worker?.terminate();
      workerRef.current = null;
    };
  }, []);

  async function startRecording() {
    if (isStarting || isRecordingRef.current || modelStatus !== "ready") {
      return;
    }

    setIsStarting(true);
    setUserError(null);
    setNotice(null);

    let mediaStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let workletNode: AudioWorkletNode | null = null;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone capture requires localhost or a secure HTTPS page.",
        );
      }

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      audioContext = new AudioContext({ latencyHint: "interactive" });
      await audioContext.audioWorklet.addModule("/audio-processor.js");

      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      workletNode = new AudioWorkletNode(
        audioContext,
        "pcm-capture-processor",
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
        },
      );

      mediaStreamRef.current = mediaStream;
      audioContextRef.current = audioContext;
      sourceNodeRef.current = sourceNode;
      workletNodeRef.current = workletNode;
      audioChunksRef.current = [];
      bufferedSamplesRef.current = 0;
      freshSamplesRef.current = 0;
      isRecordingRef.current = true;

      workletNode.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
        if (event.data instanceof Float32Array) {
          if (!isRecordingRef.current) {
            return;
          }

          audioChunksRef.current.push(event.data);
          bufferedSamplesRef.current += event.data.length;
          freshSamplesRef.current += event.data.length;

          if (
            bufferedSamplesRef.current >=
            audioContext!.sampleRate * CHUNK_SECONDS
          ) {
            flushAudioChunk(audioContext!.sampleRate, false);
          }
          return;
        }

        if (event.data.type === "flushed") {
          workletFlushResolverRef.current?.();
          workletFlushResolverRef.current = null;
        }
      };

      sourceNode.connect(workletNode);
      workletNode.connect(audioContext.destination);

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      setSecondsRecorded(0);
      setIsRecording(true);
      setMessage("Listening...");

      timerIntervalRef.current = setInterval(() => {
        setSecondsRecorded((current) => current + 1);
      }, 1000);
    } catch (error) {
      isRecordingRef.current = false;
      workletNode?.disconnect();
      sourceNode?.disconnect();
      mediaStream?.getTracks().forEach((track) => track.stop());

      if (audioContext && audioContext.state !== "closed") {
        await audioContext.close();
      }

      mediaStreamRef.current = null;
      audioContextRef.current = null;
      sourceNodeRef.current = null;
      workletNodeRef.current = null;
      setUserError(formatMicrophoneError(error));
      setMessage("Model ready");
    } finally {
      setIsStarting(false);
    }
  }

  async function stopRecording() {
    if (!isRecordingRef.current || isStopping) {
      return;
    }

    setIsStopping(true);

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    const audioContext = audioContextRef.current;
    const workletNode = workletNodeRef.current;

    if (workletNode) {
      await flushWorklet(workletNode, workletFlushResolverRef);
    }

    isRecordingRef.current = false;

    if (audioContext) {
      flushAudioChunk(audioContext.sampleRate, true);
    }

    if (workletNode) {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    }

    sourceNodeRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());

    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }

    mediaStreamRef.current = null;
    audioContextRef.current = null;
    sourceNodeRef.current = null;
    workletNodeRef.current = null;
    audioChunksRef.current = [];
    bufferedSamplesRef.current = 0;
    freshSamplesRef.current = 0;

    setIsRecording(false);
    setIsStopping(false);
    setMessage(
      pendingChunksRef.current > 0
        ? "Finishing transcription..."
        : "Recording stopped",
    );
  }

  function flushAudioChunk(sourceSampleRate: number, final: boolean) {
    const worker = workerRef.current;

    if (
      !worker ||
      bufferedSamplesRef.current === 0 ||
      freshSamplesRef.current === 0
    ) {
      return;
    }

    const requiredSamples = sourceSampleRate * CHUNK_SECONDS;

    if (!final && bufferedSamplesRef.current < requiredSamples) {
      return;
    }

    const combinedAudio = mergeAudioChunks(
      audioChunksRef.current,
      bufferedSamplesRef.current,
    );

    if (final) {
      audioChunksRef.current = [];
      bufferedSamplesRef.current = 0;
    } else {
      const overlapSamples = Math.min(
        combinedAudio.length,
        Math.round(sourceSampleRate * OVERLAP_SECONDS),
      );
      const overlap = combinedAudio.slice(-overlapSamples);
      audioChunksRef.current = [overlap];
      bufferedSamplesRef.current = overlap.length;
    }

    freshSamplesRef.current = 0;

    if (calculateRms(combinedAudio) < SILENCE_RMS_THRESHOLD) {
      return;
    }

    const audio = resampleAudio(
      combinedAudio,
      sourceSampleRate,
      TARGET_SAMPLE_RATE,
    );
    const sessionId = sessionIdRef.current;
    const id = `${sessionId}:${chunkSequenceRef.current}`;
    chunkSequenceRef.current += 1;
    pendingChunksRef.current += 1;
    setPendingChunks(pendingChunksRef.current);
    setIsWorkerBusy(true);

    worker.postMessage(
      {
        type: "transcribe",
        id,
        sessionId,
        language: languageRef.current,
        audio,
      },
      [audio.buffer],
    );
  }

  async function copyTranscript() {
    if (!transcript) {
      return;
    }

    try {
      await navigator.clipboard.writeText(transcript);
      setNotice("Transcript copied to the clipboard.");
    } catch {
      setUserError("The browser could not copy the transcript.");
    }
  }

  function clearTranscript() {
    sessionIdRef.current += 1;
    chunkSequenceRef.current = 0;
    pendingChunksRef.current = 0;
    audioChunksRef.current = [];
    bufferedSamplesRef.current = 0;
    freshSamplesRef.current = 0;

    workerRef.current?.postMessage({
      type: "reset",
      sessionId: sessionIdRef.current,
    });

    setTranscript("");
    setPendingChunks(0);
    setLastInferenceMs(null);
    setNotice(null);
    setUserError(null);

    if (!isRecordingRef.current) {
      setSecondsRecorded(0);
    }
  }

  function retryModelLoad() {
    if (!workerRef.current) {
      return;
    }

    setModelStatus("loading");
    setDownloadProgress(null);
    setUserError(null);
    setMessage("Retrying model initialisation...");
    workerRef.current.postMessage({ type: "load" });
  }

  const statusForIndicator = isRecording ? "recording" : modelStatus;
  const canRecord = modelStatus === "ready" && !isRecording;

  return (
    <main className="min-h-screen bg-neutral-950 px-5 py-10 text-white sm:py-14">
      <div className="mx-auto max-w-3xl">
        <header>
          <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-400">
            <span>Private, on-device speech recognition</span>
            <span className="rounded-full border border-neutral-800 px-3 py-1 text-xs">
              Whisper Base · Multilingual · WebGPU
            </span>
          </div>

          <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
            Live transcription
          </h1>

          <p className="mt-4 max-w-2xl leading-7 text-neutral-400">
            Your microphone audio stays in this browser. A Web Worker runs the
            speech model locally so the interface remains responsive.
          </p>
        </header>

        <section className="mt-10 rounded-3xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl shadow-black/20">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <p className="text-sm text-neutral-500">Status</p>
              <div className="mt-2 flex items-center gap-3" aria-live="polite">
                <StatusIndicator
                  status={statusForIndicator}
                  isBusy={isWorkerBusy}
                />
                <p className="font-medium">{message}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm">
              {pendingChunks > 0 && (
                <span className="rounded-full border border-neutral-700 px-3 py-2 text-neutral-400">
                  {pendingChunks} pending
                </span>
              )}
              {isRecording && (
                <span className="rounded-full border border-red-900 bg-red-950/40 px-4 py-2 font-mono text-red-200">
                  {formatDuration(secondsRecorded)}
                </span>
              )}
            </div>
          </div>

          {modelStatus === "loading" && downloadProgress !== null && (
            <div className="mt-6">
              <div className="mb-2 flex justify-between text-sm text-neutral-400">
                <span>Model download</span>
                <span>{downloadProgress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-300"
                  style={{ width: `${Math.min(downloadProgress, 100)}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-6 max-w-xs">
            <label
              htmlFor="spoken-language"
              className="block text-sm text-neutral-400"
            >
              Spoken language
            </label>
            <select
              id="spoken-language"
              value={selectedLanguage}
              disabled={isRecording || isStarting || isStopping}
              onChange={(event) => {
                const language = event.target.value as LanguageCode;
                languageRef.current = language;
                setSelectedLanguage(language);
              }}
              className="mt-2 w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white outline-none transition focus:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {LANGUAGE_OPTIONS.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            {canRecord && (
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={isStarting || isStopping}
                className="rounded-full bg-white px-6 py-3 font-medium text-black transition hover:bg-neutral-200 disabled:cursor-wait disabled:opacity-60"
              >
                {isStarting ? "Opening microphone..." : "Start recording"}
              </button>
            )}

            {isRecording && (
              <button
                type="button"
                onClick={() => void stopRecording()}
                disabled={isStopping}
                className="rounded-full bg-red-500 px-6 py-3 font-medium text-white transition hover:bg-red-400 disabled:cursor-wait disabled:opacity-60"
              >
                {isStopping ? "Stopping..." : "Stop recording"}
              </button>
            )}

            {modelStatus === "error" && (
              <button
                type="button"
                onClick={retryModelLoad}
                className="rounded-full bg-white px-6 py-3 font-medium text-black transition hover:bg-neutral-200"
              >
                Retry model load
              </button>
            )}

            <button
              type="button"
              onClick={clearTranscript}
              disabled={!transcript && secondsRecorded === 0}
              className="rounded-full border border-neutral-700 px-6 py-3 font-medium transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Clear
            </button>

            <button
              type="button"
              onClick={() => void copyTranscript()}
              disabled={!transcript}
              className="rounded-full border border-neutral-700 px-6 py-3 font-medium transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Copy
            </button>
          </div>

          {modelStatus === "unsupported" && (
            <p className="mt-6 rounded-2xl border border-amber-900 bg-amber-950/40 p-4 text-sm leading-6 text-amber-200">
              {message} Use a current Chrome or Edge release with hardware
              acceleration enabled.
            </p>
          )}

          {userError && (
            <div
              className="mt-6 flex items-start justify-between gap-4 rounded-2xl border border-red-900 bg-red-950/40 p-4 text-sm leading-6 text-red-200"
              role="alert"
            >
              <p>{userError}</p>
              <button
                type="button"
                onClick={() => setUserError(null)}
                className="shrink-0 text-red-300 underline underline-offset-4"
              >
                Dismiss
              </button>
            </div>
          )}

          {notice && !userError && (
            <p className="mt-6 rounded-2xl border border-sky-900 bg-sky-950/30 p-4 text-sm leading-6 text-sky-200">
              {notice}
            </p>
          )}
        </section>

        <section className="mt-6 min-h-80 rounded-3xl border border-neutral-800 bg-neutral-900 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-medium">Transcript</h2>
            <div className="flex gap-4 text-sm text-neutral-500">
              {lastInferenceMs !== null && (
                <span>Last chunk: {(lastInferenceMs / 1000).toFixed(1)}s</span>
              )}
              {isWorkerBusy && <span>Processing audio...</span>}
            </div>
          </div>

          <div className="mt-6" aria-live="polite">
            {transcript ? (
              <p className="whitespace-pre-wrap text-lg leading-8 text-neutral-100">
                {transcript}
              </p>
            ) : (
              <p className="text-lg leading-8 text-neutral-500">
                {getTranscriptPlaceholder(modelStatus, isRecording)}
              </p>
            )}
          </div>
        </section>

        <p className="mt-5 text-center text-xs leading-5 text-neutral-600">
          Audio is captured with an AudioWorklet, resampled to 16 kHz, and sent
          in {CHUNK_SECONDS}-second segments with a {OVERLAP_SECONDS}-second
          overlap.
        </p>
      </div>
    </main>
  );
}

function StatusIndicator({
  status,
  isBusy,
}: {
  status: ModelStatus | "recording";
  isBusy: boolean;
}) {
  const shouldPulse = status === "loading" || status === "recording" || isBusy;
  const colour =
    status === "ready"
      ? "bg-emerald-500"
      : status === "recording"
        ? "bg-red-500"
        : status === "loading" || status === "checking"
          ? "bg-amber-500"
          : "bg-red-700";

  return (
    <span className="relative flex h-3 w-3" aria-hidden="true">
      {shouldPulse && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${colour}`}
        />
      )}
      <span className={`relative inline-flex h-3 w-3 rounded-full ${colour}`} />
    </span>
  );
}

async function detectWebGpuSupport(): Promise<
  { supported: true; message: string } | { supported: false; message: string }
> {
  const navigatorWithGpu = navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<unknown | null> };
  };

  if (!navigatorWithGpu.gpu) {
    return { supported: false, message: "WebGPU is unavailable." };
  }

  try {
    const adapter = await navigatorWithGpu.gpu.requestAdapter();

    if (!adapter) {
      return {
        supported: false,
        message: "WebGPU is present, but no compatible GPU adapter is available.",
      };
    }
  } catch {
    return { supported: false, message: "WebGPU initialisation failed." };
  }

  return { supported: true, message: "WebGPU is available." };
}

async function flushWorklet(
  node: AudioWorkletNode,
  resolverRef: MutableRefObject<(() => void) | null>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    let timeoutId = 0;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);

      if (resolverRef.current === finish) {
        resolverRef.current = null;
      }

      resolve();
    };

    resolverRef.current = finish;
    node.port.postMessage({ type: "flush" });
    timeoutId = window.setTimeout(finish, 300);
  });
}

function getDownloadPercentage(progress: unknown): number | null {
  if (typeof progress !== "object" || progress === null) {
    return null;
  }

  if (
    "status" in progress &&
    progress.status === "progress_total" &&
    "progress" in progress &&
    typeof progress.progress === "number"
  ) {
    return Math.round(progress.progress);
  }

  return null;
}

function formatMicrophoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Microphone permission was denied. Allow microphone access in the browser and try again.";
    }

    if (error.name === "NotFoundError") {
      return "No microphone was found on this device.";
    }

    if (error.name === "NotReadableError") {
      return "The microphone is already in use or could not be opened.";
    }
  }

  return error instanceof Error
    ? error.message
    : "The microphone could not be opened.";
}

function getTranscriptPlaceholder(
  modelStatus: ModelStatus,
  isRecording: boolean,
): string {
  if (modelStatus === "checking" || modelStatus === "loading") {
    return "The speech model is being prepared.";
  }

  if (modelStatus === "unsupported") {
    return "Transcription requires a browser and device with WebGPU support.";
  }

  if (modelStatus === "error") {
    return "Resolve the model error, then start recording.";
  }

  return isRecording
    ? "Start speaking. Text will appear here after each audio segment."
    : "Press Start recording and begin speaking.";
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}
