export const TARGET_SAMPLE_RATE = 16_000;

export function mergeAudioChunks(
  chunks: readonly Float32Array[],
  totalLength: number,
): Float32Array {
  const output = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

export function resampleAudio(
  input: Float32Array,
  sourceRate: number,
  targetRate = TARGET_SAMPLE_RATE,
): Float32Array {
  if (input.length === 0) {
    return input;
  }

  if (sourceRate === targetRate) {
    return input;
  }

  if (sourceRate <= 0 || targetRate <= 0) {
    throw new Error("Audio sample rates must be positive.");
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.min(Math.floor(sourcePosition), input.length - 1);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const fraction = sourcePosition - leftIndex;

    output[index] =
      input[leftIndex] * (1 - fraction) + input[rightIndex] * fraction;
  }

  return output;
}

export function calculateRms(audio: Float32Array): number {
  if (audio.length === 0) {
    return 0;
  }

  let sumOfSquares = 0;

  for (const sample of audio) {
    sumOfSquares += sample * sample;
  }

  return Math.sqrt(sumOfSquares / audio.length);
}

export function appendTranscript(current: string, incoming: string): string {
  const currentWords = cleanWords(current);
  const incomingWords = cleanWords(incoming);

  if (incomingWords.length === 0) {
    return currentWords.join(" ");
  }

  if (currentWords.length === 0) {
    return incomingWords.join(" ");
  }

  const maximumOverlap = Math.min(12, currentWords.length, incomingWords.length);
  let overlap = 0;

  for (let size = maximumOverlap; size > 0; size -= 1) {
    const currentTail = currentWords.slice(-size).map(normalizeWord);
    const incomingHead = incomingWords.slice(0, size).map(normalizeWord);

    if (currentTail.every((word, index) => word === incomingHead[index])) {
      overlap = size;
      break;
    }
  }

  return [...currentWords, ...incomingWords.slice(overlap)].join(" ");
}

function cleanWords(text: string): string[] {
  return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

function normalizeWord(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}
