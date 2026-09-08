# Free Speech API Research & Final Decision — Kannada / Hindi / English

**Research date:** 2026-09-08 · **Scope:** which speech engines are truly free for Kannada + Hindi + English, and the final choice for this app.

## TL;DR (final decision, per user preference)

- **Speech-to-text (listening) = browser's built-in Web Speech API only.** It is free, installed in Chrome/Android, and most accurate in this app for all three languages (Kannada, Hindi, English). No server/cloud STT is used while the browser recognizer is available. The server `/api/stt` route remains solely as a last-resort fallback for browsers that do not support the Web Speech API at all (e.g. some desktop Firefox builds).
- **Text-to-speech (speaking) = server neural TTS only, via `/api/tts`.** The browser's built-in `speechSynthesis` voice is deliberately disabled for speaking — it is only referenced to be *cancelled*. The **default provider is Microsoft Edge "Read Aloud" neural voices** (`msedge-tts`, MIT, no API key, no credits, fast): Kannada `kn-IN-Sapna/Gagan`, Hindi `hi-IN-Swara/Madhur`, English `en-IN-Neerja/Prabhat`. Sarvam AI is only used as an optional fallback if `SARVAM_API_KEY` is set and the free provider fails.

## Research findings

### 1. The proposed IndicConformer model does not exist as written

- `ai4bharat/indicconformer_stt_kn_hybrid` — **not found on Hugging Face** (verified via the HF API).
- What AI4Bharat actually publishes for Kannada IndicConformer: `ai4bharat/indicconformer_stt_kn_hybrid_ctc_rnnt_large` — a **1.57 GB NVIDIA-NeMo `.nemo` checkpoint**, **gated** (HF login required), MIT license. It is **not** a `transformers.AutoModelForCTC` model and cannot run in Node/browser — it needs a Python + NeMo (+ GPU) service.
- The newer `ai4bharat/indic-conformer-600m-multilingual` (ONNX) is also **gated/restricted** and uses custom code — not "100% free & unrestricted".
- Conclusion: no IndicConformer variant runs inside this Node.js/Express app today. Any future adoption requires a separate Python + NeMo + GPU service.

### 2. Free speech-to-text options compared

| Option | Free? | Runs in this app? | Notes |
| --- | --- | --- | --- |
| **Browser Web Speech API** | 100% free | **Yes (chosen)** | Built into Chrome/Edge/Android; supports kn-IN/hi-IN/en-IN; no key; audio stays on device |
| Groq hosted Whisper (`whisper-large-v3-turbo`) | Free tier | Server fallback only | Requires `GROQ_API_KEY`; rate-limited |
| OpenAI Whisper open weights (ONNX via Transformers.js) | Free/Apache-2.0 | Possible but heavy/slow on CPU; poor fit vs browser API | Rejected for STT |
| Bhashini (Govt. of India) STT | Program/free | Needs registration + API key | Not "unrestricted" |
| Sarvam / AssemblyAI / Google / Azure STT | Trials/paid | Paid | Rejected |

### 3. Text-to-speech decision

- **Server neural TTS (`/api/tts` → Microsoft Edge neural voices via `msedge-tts`)** — natural, fast, 100% free (no token/credits) for Kannada/Hindi/English; used for all speaking. Optional fallback: Sarvam AI when `SARVAM_API_KEY` is set.
- Browser `speechSynthesis` is only cancelled (never used to speak).
- Optional: pre-generated audio URLs are played first when provided (fast playback), then server TTS.

## What changed in code

- `server.ts`: removed the experimental offline-Whisper STT tier (added then reverted). `/api/stt` remains the emergency fallback (Groq when configured) for browsers without the Web Speech API; it still returns `detectedLanguage`.
- `server.ts` `/api/tts`: new default provider `edgeTextToSpeech()` via the MIT-licensed `msedge-tts` npm package (Microsoft Edge Read Aloud voices, PCM WAV output, no key). Voice map: Kannada `kn-IN-SapnaNeural` (env `TTS_EDGE_VOICE_KN`), Hindi `hi-IN-SwaraNeural` (env `TTS_EDGE_VOICE_HI`), English `en-IN-NeerjaNeural` (env `TTS_EDGE_VOICE_EN`). Sarvam runs only when `TTS_PROVIDER=sarvam` or as fallback with a key. Dependency added to `package.json` (`msedge-tts ^2.0.7`) — run `npm install`.
- `src/components/VoiceAssistant.tsx` & `src/components/IVRDialer.tsx`:
  - Listening still uses the browser recognizer (primary) — unchanged.
  - Speaking goes: pre-generated `audioUrl` (if any) → server `/api/tts` (Edge neural, free). All `speechSynthesis.speak()` calls and browser-voice code removed; the synthesis object is kept only for `cancel()` cleanup.

## Speed & latency tuning (2026-09-08)

- **1.4× speaking speed**: all assistant audio plays at `playbackRate = 1.4` (pitch preserved) on both Talk and IVR screens.
- **Cut the ~3 s delay** by reducing:
  1. Post-speech silence auto-send: 3.2 s → **1.5 s** (Talk) and 2.5 s → **1.5 s** (web IVR) — this wait was a large part of the perceived delay.
  2. TTS payload: Edge output switched from 24 kHz PCM WAV → **MP3 48 kbps** (~8× smaller transfer).
  3. TTS connection overhead: one Edge WebSocket session is now **reused per voice** (new instances cost ~0.5 s handshake each request), serialized per voice.
  4. LLM latency: default Groq model order now starts with the fast `llama-3.3-70b-versatile`; pin `GROQ_MODEL=openai/gpt-oss-120b` if accuracy matters more than speed.
- Responses include the correct audio MIME (`audio/mpeg` for Edge mp3, `audio/wav` for Sarvam).

Sources: [HF API model list (ai4bharat IndicConformer)](https://huggingface.co/api/models?author=ai4bharat&search=indicconformer) · [HF Kannada IndicConformer repo](https://huggingface.co/ai4bharat/indicconformer_stt_kn_hybrid_ctc_rnnt_large) · [HF multilingual ONNX IndicConformer (restricted)](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual) · [Xenova/whisper-small (Apache-2.0, ONNX)](https://huggingface.co/Xenova/whisper-small) · [models.ai4bharat.org](https://models.ai4bharat.org/)
