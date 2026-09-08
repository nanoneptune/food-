# Free Speech (STT) API Research — Kannada / Hindi / English

**Research date:** 2026-09-08 · **Scope:** which speech-to-text engines are truly free (100% no cost, no key, no rate limit) for Kannada + Hindi + English, and what is actually usable inside this Node.js/Express app.

## TL;DR

- The exact model id from the proposed snippet — `ai4bharat/indicconformer_stt_kn_hybrid` — **does not exist on Hugging Face**. Verified via the HF API (no such repo).
- What AI4Bharat actually publishes for Kannada IndicConformer is `ai4bharat/indicconformer_stt_kn_hybrid_ctc_rnnt_large`: a **1.57 GB NVIDIA-NeMo `.nemo` checkpoint**, **gated** (HF login required to download), license MIT. It is **not** a `transformers.AutoModelForCTC` model, cannot run in Node/browser, and needs a Python + NeMo + (ideally GPU) service. The snippet would not work even in Python as written.
- The newer `ai4bharat/indic-conformer-600m-multilingual` (ONNX) is also **gated/restricted** (README and files return "access restricted") and uses custom code, so it is not "100% free & unrestricted" either.
- The best **fully free, unrestricted, runs-today** engine for Kannada + Hindi + English inside this app is **OpenAI Whisper multilingual open weights (Apache-2.0) exported to ONNX**, run locally/in-process via Transformers.js — no API key, no rate limits, audio never leaves the server.

## Verified findings (with sources)

| Source / repo | What it is | Free? | Runs in this app? |
| --- | --- | --- | --- |
| `ai4bharat/indicconformer_stt_kn_hybrid_ctc_rnnt_large` (HF) | Kannada IndicConformer, NeMo `.nemo`, 1.57 GB, `gated: auto`, MIT | Requires HF login | No (NeMo/PyTorch, GPU-oriented) |
| `ai4bharat/indicconformer_stt_hi_hybrid_ctc_rnnt_large` (HF) | Hindi IndicConformer, same NeMo pattern | Requires HF login | No |
| `ai4bharat/indic-conformer-600m-multilingual` (HF) | ONNX multilingual IndicConformer | **Restricted/gated** (access denied on README/files) | No (custom code + gated weights) |
| `ai4bharat/IndicConformer` (HF) | NeMo `.nemo`, `cc-by-4.0` | **Gated** (Space shows 401) | No |
| [models.ai4bharat.org](https://models.ai4bharat.org/) | AI4Bharat model catalog (IndicConformer described as 30M-param real-time ASR) | Free | Checkpoints are NeMo — needs Python service |
| `Xenova/whisper-small`, `Xenova/whisper-base` (HF) | OpenAI Whisper multilingual, ONNX, Apache-2.0, `gated: false` | **100% free** | **Yes — in-process via `@xenova/transformers` (already a dependency)** |
| Groq hosted Whisper (`whisper-large-v3-turbo`) | Cloud Whisper API | Free tier, but key + rate limits | Yes (already tier 1 in `/api/stt`) |
| Browser Web Speech API | Chrome/Edge/Android built-in recognizer | 100% free | Yes (client side, already used) |
| Bhashini (govt. of India) | STT/TTS for Indian languages incl. Kannada/Hindi/English | Free program access | Requires registration/API key + auth flow; not "unrestricted" |
| Sarvam AI / AssemblyAI / Google / Azure STT | Commercial cloud STT | Trials/paid | Paid beyond trials |

## Why Whisper (offline) wins for this project today

1. **Apache-2.0 weights, un-gated** — genuinely 100% free and unrestricted (verified `gated: false`, `license:apache-2.0`).
2. **No API key, no quotas** — keeps working after free-tier limits of Groq/Sarvam.
3. **Privacy** — audio stays on the server.
4. **One model covers all three languages** — Whisper multilingual natively supports Kannada, Hindi and English (auto-detect or forced).
5. **Fits the current stack** — `@xenova/transformers` + ONNX runtime is already in `package.json` and used client-side; the same library runs in Node.
6. **Zero deployment change risk** — skipped automatically on Vercel (`VERCEL=1`) where serverless function size limits make local models impractical.

Caveat: the model downloads on first use (~hundreds of MB for quantized `whisper-small`), cached under `.cache/transformers`; transcription on CPU is slower than Groq's GPU cloud (~seconds per utterance). For real-time phone IVR latency, keep the Groq key configured (tier 1); the offline tier is the guaranteed free fallback.

## What was implemented

In `server.ts`, `/api/stt` is now a three-tier engine:

1. **Tier 1 — Groq Whisper** (`whisper-large-v3-turbo`) when `GROQ_API_KEY` is set (cloud, fast). Forced-language only when the caller explicitly chose Kannada/Hindi; otherwise auto-detect.
2. **Tier 2 — Offline multilingual Whisper** (`Xenova/whisper-small`, Apache-2.0) — new. Runs locally with no key; covers Kannada/Hindi/English; used whenever Groq is absent or fails.
3. Client-side browser Web Speech API + Transformers.js fallback remain for browsers without server access.

Both server tiers return `detectedLanguage` so chat/IVR reply in the user's actual language.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `STT_OFFLINE` | `1` (outside Vercel) | `0` disables the offline tier |
| `STT_OFFLINE_MODEL` | `Xenova/whisper-small` | e.g. `Xenova/whisper-base` (smaller/faster) or `Xenova/whisper-medium` (more accurate, heavier) |
| `GROQ_API_KEY` | – | Kept for tier-1 cloud speed |

## Future: real IndicConformer (Kannada-specialized) upgrade path

If you want the best Kannada accuracy later, deploy the real AI4Bharat IndicConformer as a **separate Python + NeMo service** (it cannot live in this Node/Vercel app):

1. Accept the gated repo: `ai4bharat/indicconformer_stt_kn_hybrid_ctc_rnnt_large` (HF login → accept terms).
2. Run on a GPU box: `pip install nemo_toolkit[asr]`, load via `nemo.collections.asr.models.EncDecRNNTBPEModel.from_pretrained(...)` (NeMo API, not `AutoModelForCTC`).
3. Expose an HTTP endpoint and point `/api/stt` at it (e.g. `STT_INDIC_URL`) as tier 0 for Kannada, falling back to the tiers above.

Sources: [HF API model list (ai4bharat IndicConformer)](https://huggingface.co/api/models?author=ai4bharat&search=indicconformer) · [HF Kannada IndicConformer repo](https://huggingface.co/ai4bharat/indicconformer_stt_kn_hybrid_ctc_rnnt_large) · [HF multilingual ONNX IndicConformer (restricted)](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual) · [HF Indic ASR Space](https://huggingface.co/spaces/ai4bharat/indic-conformer) · [Xenova/whisper-small (Apache-2.0, ONNX)](https://huggingface.co/Xenova/whisper-small) · [models.ai4bharat.org](https://models.ai4bharat.org/)
