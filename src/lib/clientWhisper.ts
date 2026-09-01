import { pipeline, env } from '@xenova/transformers';

// Configure transformers.js for browser environment
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriberPromise: Promise<any> | null = null;
let isModelLoading = false;

export async function getClientWhisperPipeline(onProgress?: (progress: any) => void) {
  if (!transcriberPromise) {
    isModelLoading = true;
    try {
      transcriberPromise = pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny', // ~39MB, runs fast in browser WebAssembly
        {
          progress_callback: (p: any) => {
            if (onProgress) onProgress(p);
          },
        }
      );
    } catch (err) {
      transcriberPromise = null;
      isModelLoading = false;
      throw err;
    }
  }
  return transcriberPromise;
}

/**
 * Transcribes audio blob directly in the browser using Transformers.js (Whisper)
 * Zero backend calls, completely offline/client-side!
 */
export async function transcribeAudioInBrowser(
  audioBlob: Blob,
  language?: string
): Promise<string | null> {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;

    const audioContext = new AudioContextClass({ sampleRate: 16000 });
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    // Whisper expects 16kHz mono Float32Array
    let float32Data: Float32Array;
    if (audioBuffer.numberOfChannels === 1) {
      float32Data = audioBuffer.getChannelData(0);
    } else {
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.getChannelData(1);
      float32Data = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        float32Data[i] = (ch0[i] + ch1[i]) / 2;
      }
    }

    const transcriber = await getClientWhisperPipeline();

    // Map language for Whisper
    let whisperLang = 'english';
    if (language === 'Hindi' || language === 'hi-IN' || language === 'hi') {
      whisperLang = 'hindi';
    } else if (language === 'Kannada' || language === 'kn-IN' || language === 'kn') {
      whisperLang = 'kannada';
    }

    const result = await transcriber(float32Data, {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: whisperLang,
      task: 'transcribe',
    });

    try {
      await audioContext.close();
    } catch {}

    const text = typeof result === 'string' ? result : (result?.text || '');
    return text.trim() || null;
  } catch (err) {
    console.warn("In-browser Whisper transcription notice:", err);
    return null;
  }
}
