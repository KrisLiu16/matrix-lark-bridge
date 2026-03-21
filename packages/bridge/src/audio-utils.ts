/**
 * Shared audio conversion utility — OGG Opus → PCM 16kHz mono.
 * Reuses a single OggOpusDecoder WASM instance across calls (Node.js is single-threaded).
 */

let cachedDecoder: any = null;
let decoderReady: Promise<void> | null = null;

async function getDecoder(): Promise<any> {
  if (cachedDecoder) return cachedDecoder;
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  cachedDecoder = new OggOpusDecoder();
  decoderReady = cachedDecoder.ready;
  await decoderReady;
  return cachedDecoder;
}

/**
 * Convert OGG Opus audio buffer to PCM 16kHz mono int16 format.
 * Suitable for Feishu ASR API (speech_to_text).
 */
export async function convertAudioToPcm(audioBuffer: Buffer): Promise<Buffer> {
  const decoder = await getDecoder();

  const { channelData, sampleRate } = await decoder.decodeFile(new Uint8Array(audioBuffer));
  const floats = channelData[0]; // mono channel

  // Resample to 16kHz + float32 → int16
  const ratio = sampleRate / 16000;
  const outLen = Math.floor(floats.length / ratio);
  const pcm = Buffer.alloc(outLen * 2); // 2 bytes per int16 sample
  for (let i = 0; i < outLen; i++) {
    const sample = Math.max(-1, Math.min(1, floats[Math.floor(i * ratio)]));
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }

  // Note: we do NOT call decoder.free() — instance is reused.
  // WASM memory is freed when the process exits.
  return pcm;
}
