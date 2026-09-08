import express, { Request } from "express";
import path from "path";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@libsql/client";
import Tesseract from "tesseract.js";
import twilio from "twilio";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { PassThrough } from "stream";

dotenv.config();

try {
  if (ffmpegInstaller && ffmpegInstaller.path) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  }
} catch (e) {
  console.warn("FFmpeg path setup notice:", e);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Helper to convert WebM/audio buffer to WAV buffer for strict APIs (like Sarvam)
async function convertWebmToWav(buffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const fs = await import("fs");
  const path = await import("path");
  const tmpIn = path.join(os.tmpdir(), `in_${Date.now()}_${Math.random().toString(36).slice(2)}.webm`);
  const tmpOut = path.join(os.tmpdir(), `out_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);

  await fs.promises.writeFile(tmpIn, buffer);
  return new Promise((resolve, reject) => {
    ffmpeg(tmpIn)
      .toFormat("wav")
      .audioChannels(1)
      .audioFrequency(16000)
      .on("end", async () => {
        try {
          const wavBuf = await fs.promises.readFile(tmpOut);
          await fs.promises.unlink(tmpIn).catch(() => {});
          await fs.promises.unlink(tmpOut).catch(() => {});
          resolve(wavBuf);
        } catch (e) {
          reject(e);
        }
      })
      .on("error", async (err) => {
        await fs.promises.unlink(tmpIn).catch(() => {});
        await fs.promises.unlink(tmpOut).catch(() => {});
        reject(err);
      })
      .save(tmpOut);
  });
}

// Helper for timeout-safe fetch
async function fetchWithTimeout(url: string, options: any = {}, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Universal Fast & Resilient LLM Invocation Helper (Groq + OpenAI)
async function runLLMGeneration({
  system,
  prompt,
  messages,
}: {
  system?: string;
  prompt?: string;
  messages?: any[];
}): Promise<string> {
  let formattedMessages = messages && messages.length > 0
    ? messages
    : [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt || "" }
      ];

  if (system && messages && messages.length > 0) {
    if (messages[0]?.role !== "system") {
      formattedMessages = [{ role: "system", content: system }, ...messages];
    }
  }

  // 1. Primary Option: Groq Fast LLM Inference. "openai/gpt-oss-120b" is the user-selected
  //    working model; the rest are fallbacks if a model becomes unavailable.
  const groqKey = process.env.GROQ_API_KEY;
  const groqModels = [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-20b",
  ];

  if (groqKey && groqKey !== "YOUR_GROQ_API_KEY") {
    for (const model of groqModels) {
      try {
        const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: formattedMessages,
            // Generous budget: gpt-oss models spend tokens on internal reasoning
            // before producing the answer, so a small max_tokens yields empty content.
            max_tokens: 4096,
          }),
        }, 30000);

        if (groqRes.ok) {
          const data: any = await groqRes.json();
          const reply = data?.choices?.[0]?.message?.content;
          if (reply && reply.trim()) {
            return reply.trim();
          }
          // HTTP 200 but no content (e.g. budget fully consumed by reasoning) — try next model
          console.warn(`Groq model "${model}" returned an empty response (finish_reason: ${data?.choices?.[0]?.finish_reason || "unknown"}); trying next model...`);
        } else {
          console.warn(`Groq model "${model}" unavailable (HTTP ${groqRes.status}); trying next model...`);
        }
      } catch (e: any) {
        console.warn(`Groq API fallback notice for ${model}:`, e?.message);
      }
    }
  }

  return "";
}

// Turso Setup (Safely optional if database credentials are not configured in environment)
let tursoClient: any = null;

function getTurso() {
  if (!tursoClient) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      return null;
    }
    tursoClient = createClient({ 
      url: url, 
      authToken: authToken 
    });
  }
  return tursoClient;
}

// Cloudinary Setup
cloudinary.config({
  cloudinary_url: process.env.CLOUDINARY_URL,
});

// Initializing DB
async function initDB() {
  try {
    const turso = getTurso();
    if (!turso) {
      console.warn("Turso DB URL not set in environment; skipping DB initialization.");
      return;
    }
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS complaints (
        id TEXT PRIMARY KEY,
        name TEXT,
        phoneNumber TEXT,
        location TEXT,
        query TEXT,
        status TEXT,
        chatHistory TEXT,
        mediaUrls TEXT,
        audioUrl TEXT,
        createdAt INTEGER,
        adminReply TEXT,
        adminReplyAt INTEGER
      )
    `);

    // Ensure columns exist on existing table instances
    try {
      await turso.execute(`ALTER TABLE complaints ADD COLUMN adminReply TEXT`);
    } catch (e) {}
    try {
      await turso.execute(`ALTER TABLE complaints ADD COLUMN adminReplyAt INTEGER`);
    } catch (e) {}
    
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id TEXT PRIMARY KEY,
        name TEXT,
        content TEXT,
        type TEXT,
        createdAt INTEGER
      )
    `);

    await turso.execute(`
      CREATE TABLE IF NOT EXISTS qa_cache (
        id TEXT PRIMARY KEY,
        normalized_intent TEXT,
        language TEXT,
        question TEXT,
        answer TEXT,
        audio_url TEXT,
        created_at INTEGER
      )
    `);

    // Seed default common Q&A items if table is empty
    try {
      const existing = await turso.execute("SELECT COUNT(*) as cnt FROM qa_cache");
      const count = Number(existing.rows[0]?.cnt || 0);
      if (count === 0) {
        const seedItems = [
          {
            id: "seed_fssai_def_en",
            normalized_intent: "definition_fssai",
            language: "English",
            question: "What is FSSAI?",
            answer: "FSSAI stands for the Food Safety and Standards Authority of India. It is an autonomous body under the Ministry of Health & Family Welfare that regulates food safety, quality standards, and hygiene compliance across India."
          },
          {
            id: "seed_fssai_work_en",
            normalized_intent: "working_fssai",
            language: "English",
            question: "How does FSSAI work?",
            answer: "FSSAI works by setting science-based food quality standards, issuing mandatory food business licenses, conducting kitchen hygiene inspections, and testing food samples to protect consumer health."
          },
          {
            id: "seed_complaint_en",
            normalized_intent: "file_complaint",
            language: "English",
            question: "How do I register a complaint?",
            answer: "You can register a complaint by describing your issue here or uploading photos. I will draft a formal report, record your details, and submit it directly to our support team."
          },
          {
            id: "seed_fssai_def_hi",
            normalized_intent: "definition_fssai",
            language: "Hindi",
            question: "FSSAI क्या है?",
            answer: "FSSAI भारतीय खाद्य सुरक्षा और मानक प्राधिकरण है। यह भारत में भोजन की गुणवत्ता, स्वच्छता और सुरक्षा मानकों को विनियमित करने वाली एक प्रमुख सरकारी संस्था है।"
          },
          {
            id: "seed_fssai_work_hi",
            normalized_intent: "working_fssai",
            language: "Hindi",
            question: "FSSAI कैसे काम करता है?",
            answer: "FSSAI खाद्य लाइसेंस जारी करके, रसोईघरों की स्वच्छता की जाँच करके और भोजन के नमूनों का परीक्षण करके काम करता है ताकि उपभोक्ताओं को सुरक्षित भोजन मिल सके।"
          },
          {
            id: "seed_fssai_def_kn",
            normalized_intent: "definition_fssai",
            language: "Kannada",
            question: "FSSAI ಎಂದರೆ ಏನು?",
            answer: "FSSAI ಅಂದರೆ ಭಾರತೀಯ ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಪ್ರಾಧಿಕಾರ. ಇದು ಭಾರತದಲ್ಲಿ ಆಹಾರದ ಗುಣಮಟ್ಟ, ನೈರ್ಮಲ್ಯ ಮತ್ತು ಸುರಕ್ಷತೆಯನ್ನು ನಿಯಂತ್ರಿಸುವ ಸರ್ಕಾರಿ ಸಂಸ್ಥೆಯಾಗಿದೆ."
          },
          {
            id: "seed_fssai_work_kn",
            normalized_intent: "working_fssai",
            language: "Kannada",
            question: "FSSAI ಹೇಗೆ ಕೆಲಸ ಮಾಡುತ್ತದೆ?",
            answer: "FSSAI ಆಹಾರ ಸಂಸ್ಥೆಗಳಿಗೆ ಪರವಾನಗಿ ನೀಡುವುದು, ಅಡುಗೆಮನೆಗಳ ನೈರ್ಮಲ್ಯ ತಪಾಸಣೆ ಮಾಡುವುದು ಮತ್ತು ಆಹಾರದ ಮಾದರಿಗಳನ್ನು ಪರೀಕ್ಷಿಸುವ ಮೂಲಕ ಕಾರ್ಯನಿರ್ವಹಿಸುತ್ತದೆ."
          }
        ];

        for (const item of seedItems) {
          await turso.execute({
            sql: `INSERT INTO qa_cache (id, normalized_intent, language, question, answer, audio_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [item.id, item.normalized_intent, item.language, item.question, item.answer, "", Date.now()]
          });
        }
      }
    } catch (sErr: any) {
      console.warn("Seeding qa_cache notice:", sErr?.message);
    }
  } catch (error: any) {
    console.warn("Database initialization skipped or failed:", error.message);
  }
}
initDB();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Twilio Client Setup
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || process.env.TWILIO_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_SECRET;

let twilioClient: any = null;
try {
  if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
    twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID });
  } else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  } else if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) {
    twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET);
  }
} catch (err) {
  console.warn("Twilio client initialization notice:", err);
}

// ---------------------------------------------------------------------------
// Per-call IVR memory (keyed by Twilio CallSid). Keeps the chosen language,
// the extracted complaint details and the recent conversation so the IVR never
// restarts, never repeats a question, and always replies in the SAME language
// the caller chose (e.g. pressed 1 for Kannada).
// ---------------------------------------------------------------------------
interface CallSession {
  lang: string;            // kn-IN | hi-IN | en-IN
  langName: string;        // Kannada | Hindi | English
  history: { role: "user" | "assistant"; content: string }[];
  data: { cause?: string; location?: string; when?: string; item?: string };
  noSpeechCount: number;
  lastActivity: number;
}
const callSessions = new Map<string, CallSession>();

function getCallSession(callSid: string): CallSession | null {
  if (!callSid) return null;
  const s = callSessions.get(callSid);
  if (s) s.lastActivity = Date.now();
  return s || null;
}

function newCallSession(callSid: string, lang: string, langName: string): CallSession {
  const s: CallSession = { lang, langName, history: [], data: {}, noSpeechCount: 0, lastActivity: Date.now() };
  if (callSid) callSessions.set(callSid, s);
  return s;
}

function sessionHistoryText(s: CallSession): string {
  const recent = s.history.slice(-8);
  if (recent.length === 0) return "No previous conversation.";
  return recent.map(h => `${h.role === "user" ? "Caller" : "Assistant"}: ${h.content}`).join("\n");
}

// Prune abandoned sessions so the map never grows unbounded.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour TTL
  for (const [sid, s] of callSessions.entries()) {
    if (s.lastActivity < cutoff) callSessions.delete(sid);
  }
}, 10 * 60 * 1000).unref?.();

// Detect the caller's language choice from a DTMF digit and/or recognized
// speech at the welcome menu (supports Kannada/Hindi words and script).
function languageChoiceFromInput(digits: string, speech: string): { lang: string; langName: string } | null {
  const d = (digits || "").trim();
  const sp = (speech || "").toLowerCase().trim();
  const scriptLang = detectTextLanguage(sp);
  if (d === "1" || /(^|\W)(one|kannada|kn|ondu|ondanna)(\W|$)/.test(sp) || scriptLang === "Kannada") {
    return { lang: "kn-IN", langName: "Kannada" };
  }
  if (d === "2" || /(^|\W)(two|hindi|do|हिंदी|हिन्दी|ದೋ|ಎರಡು)(\W|$)/.test(sp) || scriptLang === "Hindi") {
    return { lang: "hi-IN", langName: "Hindi" };
  }
  if (d === "3" || /(^|\W)(three|english|angrezi|ಇಂಗ್ಲಿಷ್|ಮೂರು|तीन)(\W|$)/.test(sp)) {
    return { lang: "en-IN", langName: "English" };
  }
  return null;
}

// Localized helper messages used by the phone IVR.
function phoneNoSpeechMessage(lang: string): string {
  if (lang === "kn-IN") return "ಕ್ಷಮಿಸಿ, ತಮ್ಮ ಧ್ವನಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಬೀಪ್ ನಂತರ ಮಾತನಾಡಿ.";
  if (lang === "hi-IN") return "माफ़ कीजिए, आपकी आवाज़ सुनाई नहीं दी। कृपया बीप के बाद बोलें।";
  return "Sorry, I could not hear you. Please speak after the tone.";
}

function phoneImageGuidance(lang: string): string {
  if (lang === "kn-IN") return "ಕ್ಷಮಿಸಿ, ತಮ್ಮ ಮಾತು ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸುತ್ತಿಲ್ಲ. ಸಮಸ್ಯೆಯ ಆಹಾರ, ಪ್ಯಾಕೆಟ್ ಅಥವಾ ಬಿಲ್ ನ ಫೋಟೋ ಇದ್ದರೆ, VoxAssist ಚಾಟ್ ನಲ್ಲಿ ಫೋಟೋ ಸೇರಿಸಿ. ಅದರಿಂದ ನಮ್ಮ ತಂಡ ಬೇಗನೆ ಸಹಾಯ ಮಾಡುತ್ತದೆ. ಧನ್ಯವಾದಗಳು, ಬೈ!";
  if (lang === "hi-IN") return "माफ़ कीजिए, आपकी आवाज़ स्पष्ट नहीं आ रही है। यदि समस्या के भोजन, पैकेट या बिल की फोटो है, तो उसे VoxAssist चैट में भेजें, हमारी टीम जल्द सहायता करेगी। धन्यवाद, बाय!";
  return "Sorry, I could not hear you clearly. If you have a photo of the food, packet or bill, please upload it in the VoxAssist chat app and our team will act faster. Thank you, goodbye!";
}

// Build the localized question for one missing complaint detail.
function phoneMissingDetailQuestion(lang: string, missing: string): string {
  if (lang === "kn-IN") {
    if (missing === "location") return "ದಯವಿಟ್ಟು ಈ ಘಟನೆ ನಡೆದ ಹೋಟೆಲ್, ಅಂಗಡಿ ಅಥವಾ ಸ್ಥಳದ ಹೆಸರನ್ನು ತಿಳಿಸಿ.";
    if (missing === "when") return "ಈ ಘಟನೆ ಯಾವ ದಿನ ಮತ್ತು ಯಾವ ಸಮಯಕ್ಕೆ ನಡೆಯಿತು, ದಯವಿಟ್ಟು ತಿಳಿಸಿ.";
    return "ಸಮಸ್ಯೆ ಏನು, ಏನು ತಪ್ಪಾಗಿದೆ ಎಂಬುದನ್ನು ವಿವರವಾಗಿ ಹೇಳಿ.";
  }
  if (lang === "hi-IN") {
    if (missing === "location") return "कृपया उस रेस्टोरेंट, दुकान या स्थान का नाम बताएं जहाँ यह समस्या हुई।";
    if (missing === "when") return "यह घटना किस दिन और किस समय हुई, कृपया बताएं।";
    return "कृपया बताएं कि समस्या क्या थी और क्या गलत हुआ।";
  }
  if (missing === "location") return "Please tell me the name of the restaurant, shop or place where this happened.";
  if (missing === "when") return "Please tell me on which day and at what time this happened.";
  return "Please describe what the problem was and what went wrong.";
}

// Twilio Voice IVR Initial Webhook Endpoint (Language Selection Menu)
app.all("/api/voice", (req: any, res: any) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: ["dtmf", "speech"],
    numDigits: 1,
    action: "/api/voice/menu-select",
    method: "POST",
    timeout: 6,
  });

  // 1 for Kannada, 2 for Hindi, 3 for English.
  // Only the first (Kannada) line carries the welcome; 2 and 3 are short instructions.
  gather.say({ voice: "Google.kn-IN-Standard-A" as any, language: "kn-IN" as any }, "ನಮಸ್ಕಾರ! VoxAssist ಆಹಾರ ಸುರಕ್ಷತಾ ಸಹಾಯವಾಣಿಗೆ ಸ್ವಾಗತ. ಕನ್ನಡಕ್ಕಾಗಿ ಒಂದನ್ನು ಒತ್ತಿ.");
  gather.say({ voice: "Google.hi-IN-Wavenet-A" as any, language: "hi-IN" as any }, "हिंदी के लिए दो दबाएं।");
  gather.say({ voice: "Google.en-IN-Standard-A" as any, language: "en-IN" as any }, "For English, press 3.");

  twiml.say({ voice: "Google.kn-IN-Standard-A" as any, language: "kn-IN" as any }, "ಯಾವುದೇ ಆಯ್ಕೆ ಸಿಗಲಿಲ್ಲ.");
  twiml.say({ voice: "Google.hi-IN-Wavenet-A" as any, language: "hi-IN" as any }, "कोई विकल्प प्राप्त नहीं हुआ।");
  twiml.say({ voice: "Google.en-IN-Standard-A" as any }, "No selection received. Please try again.");
  twiml.redirect("/api/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Handle Language Selection (DTMF Digit 1, 2, 3 or Speech Keyword)
app.all("/api/voice/menu-select", (req: any, res: any) => {
  const digits = (req.body.Digits || "").trim();
  const speech = (req.body.SpeechResult || "");
  const callSid = req.body.CallSid || "";
  const twiml = new twilio.twiml.VoiceResponse();

  const chosen = languageChoiceFromInput(digits, speech);

  if (!chosen) {
    // Invalid key / unrecognized speech: apologize in all three languages (never
    // English-only, which frustrated Kannada/Hindi callers) and re-prompt.
    const retryGather = twiml.gather({
      input: ["dtmf", "speech"],
      numDigits: 1,
      action: "/api/voice/menu-select",
      method: "POST",
      timeout: 6,
    });
    retryGather.say({ voice: "Google.kn-IN-Standard-A" as any, language: "kn-IN" as any }, "ಕ್ಷಮಿಸಿ, ಆಯ್ಕೆ ಸರಿಯಿಲ್ಲ. ಕನ್ನಡಕ್ಕೆ 1 ಒತ್ತಿ.");
    retryGather.say({ voice: "Google.hi-IN-Wavenet-A" as any, language: "hi-IN" as any }, "क्षमा करें, यह विकल्प मान्य नहीं है। हिंदी के लिए 2 दबाएँ।");
    retryGather.say({ voice: "Google.en-IN-Standard-A" as any }, "Sorry, that option is not valid. For English, press 3.");
    twiml.redirect("/api/voice");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Start / restore the per-call session and LOCK it to the selected language.
  const session = getCallSession(callSid) || newCallSession(callSid, chosen.lang, chosen.langName);
  session.lang = chosen.lang;
  session.langName = chosen.langName;
  session.noSpeechCount = 0;
  session.lastActivity = Date.now();

  const ttsVoice = chosen.lang === "kn-IN"
    ? "Google.kn-IN-Standard-A"
    : chosen.lang === "hi-IN"
      ? "Google.hi-IN-Wavenet-A"
      : "Google.en-IN-Standard-A";

  const greetingText = chosen.lang === "kn-IN"
    ? "ನಮಸ್ಕಾರ! ದಯವಿಟ್ಟು ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಅಥವಾ ದೂರನ್ನು ಸ್ಪಷ್ಟವಾಗಿ ತಿಳಿಸಿ."
    : chosen.lang === "hi-IN"
      ? "नमस्ते! कृपया अपना प्रश्न या शिकायत स्पष्ट रूप से बताएं।"
      : "Hello! Please clearly tell me your question or complaint.";

  const respondUrl = `/api/voice/respond?lang=${encodeURIComponent(chosen.lang)}&langName=${encodeURIComponent(chosen.langName)}`;

  const gather = twiml.gather({
    input: ["speech"],
    action: respondUrl,
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
    language: chosen.lang as any,
  });
  gather.say({ voice: ttsVoice as any }, greetingText);

  twiml.say({ voice: ttsVoice as any }, chosen.lang === "kn-IN"
    ? "ಯಾವುದೇ ಧ್ವನಿ ಪತ್ತೆಯಾಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಬೀಪ್ ನಂತರ ಮಾತನಾಡಿ."
    : chosen.lang === "hi-IN"
      ? "कोई आवाज़ नहीं मिली। कृपया बीप के बाद बोलें।"
      : "No speech detected. Please speak after the tone.");
  twiml.redirect(respondUrl);

  res.type("text/xml");
  res.send(twiml.toString());
});

// Register a phone complaint into Turso and return the case id.
async function registerPhoneComplaint(session: CallSession, callerPhone: string): Promise<string> {
  const caseId = `GRV-${Date.now().toString().slice(-6)}`;
  const cause = session.data.cause || "Food hygiene & quality discrepancy";
  const location = session.data.location || "Unspecified Branch";
  const item = session.data.item || "Food Item";
  const when = session.data.when || "Not specified";

  const markdownReport = `# 📋 Official Consumer Grievance Report
> **Reference ID:** #${caseId} | **Channel:** IVR Helpline (1800-FOOD-VOX) | **Priority:** High | **Status:** Logged & Under Review

---

### 📍 Incident Specifics
| Parameter | Record Details |
| :--- | :--- |
| **Consumer Name** | IVR Caller |
| **Contact Phone** | ${callerPhone || "Phone On File"} |
| **Incident Location** | ${location} |
| **Affected Item** | ${item} |
| **Incident Time** | ${when} |
| **Core Cause / Violation** | ${cause} |
| **Incident Timestamp** | ${new Date().toLocaleString()} |

---

### 🔍 Cause & Incident Breakdown
${cause}

### ⚠️ Safety & Compliance Protocol
- **Hygiene & Safety Assessment:** Immediate compliance audit initiated.
- **Regulatory Framework:** FSSAI Schedule 4 Standards & Consumer Protection Act 2019.

### 📌 Corrective Actions
1. Immediate notification sent to outlet manager at ${location}.
2. Redressal & refund processing scheduled.
3. Call transcript archived for administrative review.

---
*Report filed via VoxAssist IVR Voice System*`;

  try {
    const turso = getTurso();
    if (turso) {
      await turso.execute({
        sql: `INSERT INTO complaints (id, name, phoneNumber, location, query, status, chatHistory, mediaUrls, audioUrl, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          caseId,
          "IVR Caller",
          callerPhone || "IVR Phone",
          location,
          markdownReport,
          "pending",
          JSON.stringify(session.history || []),
          "[]",
          "",
          Date.now(),
        ],
      });
      console.log(`[Twilio IVR] Successfully registered complaint ${caseId} in Turso DB`);
    }
  } catch (dbErr: any) {
    console.warn("[Twilio IVR] Turso insert notice:", dbErr?.message);
  }
  return caseId;
}

function phoneGoodbyeMessage(lang: string): string {
  if (lang === "kn-IN") return "ಧನ್ಯವಾದಗಳು, ಆಹಾರ ಸುರಕ್ಷತಾ ಸಹಾಯವಾಣಿಗೆ ಕರೆ ಮಾಡಿದ್ದಕ್ಕಾಗಿ ವಂದನೆಗಳು. ಬೈ!";
  if (lang === "hi-IN") return "खाद्य सुरक्षा हेल्पलाइन में संपर्क करने के लिए धन्यवाद। बाय!";
  return "Thank you for calling the Food Safety Helpline. Goodbye!";
}

function phoneSubmitPrompt(lang: string): string {
  if (lang === "kn-IN") return "ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ, ಅಥವಾ ದೃಢೀಕರಿಸಿ ಎಂದು ಹೇಳಿ.";
  if (lang === "hi-IN") return "शिकायत दर्ज करने के लिए 9 दबाएँ या पुष्टि करें कहें।";
  return "To submit your complaint press 9, or say confirm.";
}

// Twilio Voice IVR Conversation Loop in Selected Language (with per-call memory)
app.all("/api/voice/respond", async (req: any, res: any) => {
  const callSid = req.body.CallSid || "";
  const callerPhone = req.body.From || "";
  const queryLang = (req.query.lang as string) || "";

  let session = getCallSession(callSid);
  if (!session) {
    const l = queryLang || "kn-IN";
    session = newCallSession(callSid, l, languageNameOf(l));
  }
  const lang = session.lang;
  const ttsVoice = lang === "kn-IN"
    ? "Google.kn-IN-Standard-A"
    : lang === "hi-IN"
      ? "Google.hi-IN-Wavenet-A"
      : "Google.en-IN-Standard-A";
  const respondUrl = `/api/voice/respond?lang=${encodeURIComponent(lang)}&langName=${encodeURIComponent(session.langName)}`;
  const twiml = new twilio.twiml.VoiceResponse();

  const digits = (req.body.Digits || "").trim();
  const rawSpeech = String(req.body.SpeechResult || req.body.UnstableSpeechResult || "").trim();
  const userSpeech = sanitizeSpeechText(rawSpeech);

  const wantsSubmit = digits === "9" || /(^|\W)(9|nine|submit|confirm|sari|ha|yes|ದೃಢೀಕರಿಸಿ|ಒಂಬತ್ತು|ಸಲ್ಲಿಸಿ|सबमिट|पुष्टि|हाँ|नौ)(\W|$)/i.test(userSpeech);

  // 1. Caller pressed 9 / said confirm → register & end politely.
  if (wantsSubmit) {
    const missing = firstMissingDetail(session.data);
    if (missing) {
      // Not enough detail yet: ask ONLY the first genuinely missing field once.
      session.history.push({ role: "user", content: userSpeech || "Pressed submit" });
      const question = phoneMissingDetailQuestion(lang, missing);
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: respondUrl,
        method: "POST",
        speechTimeout: "auto",
        timeout: 6,
        language: lang as any,
      });
      gather.say({ voice: ttsVoice as any }, phoneMissingDetailQuestion(lang, missing));
      session.history.push({ role: "assistant", content: question });
      twiml.redirect(respondUrl);
      res.type("text/xml");
      return res.send(twiml.toString());
    }
    const caseId = await registerPhoneComplaint(session, callerPhone);
    session.history.push({ role: "user", content: userSpeech || "Pressed 9 to submit" });
    const confirmText = lang === "kn-IN"
      ? `ನಿಮ್ಮ ದೂರು ಸಂಖ್ಯೆ ${caseId} ಯಶಸ್ವಿಯಾಗಿ ನೋಂದಾಯಿಸಲ್ಪಟ್ಟಿದೆ. ನಾವು ಮುಂದಿನ ಕ್ರಮ ಕೈಗೊಳ್ಳುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು! ಬೈ, ತಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ!`
      : lang === "hi-IN"
        ? `आपकी शिकायत संख्या ${caseId} सफलतापूर्वक दर्ज हो गई है। हम आगे की कार्रवाई करेंगे। धन्यवाद! बाय, आपका दिन शुभ हो!`
        : `Your complaint reference number ${caseId} has been registered successfully. We will take care of it. Thank you! Bye, have a nice day!`;
    session.history.push({ role: "assistant", content: confirmText });
    twiml.say({ voice: ttsVoice as any }, sanitizeSpeechText(confirmText));
    twiml.hangup();
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // 2. No speech at all.
  if (!userSpeech) {
    session.noSpeechCount += 1;
    const msg = session.noSpeechCount >= 2 ? phoneImageGuidance(lang) : phoneNoSpeechMessage(lang);
    if (session.noSpeechCount >= 2) {
      twiml.say({ voice: ttsVoice as any }, sanitizeSpeechText(msg));
      twiml.hangup();
    } else {
      const gather = twiml.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: respondUrl,
        method: "POST",
        speechTimeout: "auto",
        timeout: 6,
        language: lang as any,
      });
      gather.say({ voice: ttsVoice as any }, sanitizeSpeechText(msg));
      twiml.redirect(respondUrl);
    }
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  session.noSpeechCount = 0;

  // 3. Understand the caller's speech: extract complaint details, detect
  //    whether they are ending the call, and build a natural ack sentence —
  //    ALL with awareness of the previous conversation (per-call memory).
  const extractionPrompt = `You are a calm, gentle, highly empathetic phone IVR agent for VoxAssist Consumer Food Safety Helpline.
The caller speaks: ${session.langName}. You MUST think and reply in ${session.langName}.
Caller phone: ${callerPhone || "On File"}.

Conversation so far:
${sessionHistoryText(session)}

Currently known details:
- Cause: ${session.data.cause || "Unknown"}
- Location/Where: ${session.data.location || "Unknown"}
- When: ${session.data.when || "Unknown"}
- Item: ${session.data.item || "Unknown"}

Caller just said: "${userSpeech}"

Instructions:
1. Extract any newly mentioned cause (what went wrong), location/where (restaurant, shop, address), when (day/time), and food item name from this latest message only.
2. If the caller is clearly ending the call (thanks, bye, nothing else, goodbye) and is NOT describing a new problem, set byeIntent=true.
3. Set understood=true only if you could make sense of their speech. If it is noise or unclear, set understood=false.
4. ack must be 1 short, warm, reassuring sentence in ${session.langName} acknowledging what they just said. Never repeat what is already known and never ask a question in ack.
5. When writing ${session.langName === "Kannada" ? "Kannada, use respectful words (ನಮಸ್ಕಾರ, ದಯವಿಟ್ಟು, ತಾವು, ತಮ್ಮ, ಸವಿನಯವಾಗಿ). In Hindi use (नमस्ते, कृपया)." : session.langName === "Hindi" ? "Hindi, use respectful words (नमस्ते, कृपया)." : "English, never use Kannada or Hindi greetings."}
6. Plain spoken words only: no emojis, no markdown, no symbols, no tables. Use FULL words only: never abbreviate (never write "ಉದಾ", "ex", "e.g.", "i.e.", "etc."; write ಉದಾಹರಣೆಗೆ / example / that is / and so on fully).
7. Do NOT ask the caller any question inside ack.

Respond with ONLY valid JSON (no code fences, no extra text):
{
  "cause": "updated or existing cause",
  "location": "updated or existing location",
  "when": "updated or existing when",
  "item": "updated or existing item",
  "ack": "one short polite sentence in ${session.langName}",
  "byeIntent": true/false,
  "understood": true/false
}`;

  let parsed: any = {};
  try {
    const aiResponse = await runLLMGeneration({ prompt: extractionPrompt }) || "{}";
    parsed = JSON.parse(extractJsonBlock(aiResponse));
  } catch {
    parsed = { understood: false, byeIntent: false };
  }

  if (parsed.cause) session.data.cause = parsed.cause;
  if (parsed.location) session.data.location = parsed.location;
  if (parsed.when) session.data.when = parsed.when;
  if (parsed.item) session.data.item = parsed.item;

  session.history.push({ role: "user", content: userSpeech });
  const missing = firstMissingDetail(session.data);
  const byeIntent = parsed.byeIntent === true || /(^|\W)(bye|goodbye|thank you|thanks|nothing else|no thanks|dhanyavada|ವಂದನೆ|ಬೈ|धन्यवाद|बाय)(\W|$)/i.test(userSpeech);

  let replyText = "";
  let endCall = false;

  if (byeIntent) {
    // Caller is leaving.
    if (!missing) {
      // They described a full complaint earlier: register it so their grievance is never lost.
      const caseId = await registerPhoneComplaint(session, callerPhone);
      replyText = lang === "kn-IN"
        ? `ನಿಮ್ಮ ದೂರು ಸಂಖ್ಯೆ ${caseId} ರನ್ನು ನೋಂದಾಯಿಸಲಾಗಿದೆ. ಧನ್ಯವಾದಗಳು, ಬೈ!`
        : lang === "hi-IN"
          ? `आपकी शिकायत संख्या ${caseId} दर्ज कर ली गई है। धन्यवाद, बाय!`
          : `Your complaint number ${caseId} has been registered. Thank you, goodbye!`;
    } else {
      replyText = phoneGoodbyeMessage(lang);
    }
    endCall = true;
  } else if (parsed.understood === false && !parsed.cause && !parsed.location && !parsed.when) {
    // Unclear speech: ask once to repeat slowly; second consecutive failure →
    // give photo guidance and end instead of interrogating the caller.
    session.noSpeechCount += 1;
    replyText = session.noSpeechCount >= 2 ? phoneImageGuidance(lang) : (lang === "kn-IN"
      ? "ಕ್ಷಮಿಸಿ, ತಮ್ಮ ಮಾತು ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಧಾನವಾಗಿ ಒಮ್ಮೆ ಮತ್ತೆ ಹೇಳಿ."
      : lang === "hi-IN"
        ? "माफ़ कीजिए, आपकी आवाज़ स्पष्ट नहीं आई। कृपया धीरे-धीरे एक बार फिर बोलें।"
        : "Sorry, I could not understand. Please speak slowly once more.");
    if (session.noSpeechCount >= 2) endCall = true;
  } else if (!missing) {
    // Enough detail collected → summarize once and ask for submission only.
    const submitPrompt = phoneSubmitPrompt(lang);
    replyText = `${sanitizeSpeechText(parsed.ack || (lang === "kn-IN"
      ? "ಧನ್ಯವಾದಗಳು, ತಮ್ಮ ವಿವರಗಳನ್ನು ದಾಖಲಿಸಲಾಗಿದೆ."
      : lang === "hi-IN"
        ? "धन्यवाद, आपकी जानकारी नोट कर ली गई है।"
        : "Thank you, I have noted down your details."))} ${submitPrompt}`;
  } else {
    // Still missing one detail: ask ONLY that one (never a fixed question).
    const question = phoneMissingDetailQuestion(lang, missing);
    const ack = sanitizeSpeechText(parsed.ack || "");
    replyText = ack ? `${ack} ${question}` : question;
  }

  const finalReply = await enforceLanguage(sanitizeSpeechText(replyText), lang);
  session.history.push({ role: "assistant", content: finalReply });

  if (endCall) {
    twiml.say({ voice: ttsVoice as any }, finalReply);
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: ["speech", "dtmf"],
      numDigits: 1,
      action: respondUrl,
      method: "POST",
      speechTimeout: "auto",
      timeout: 6,
      language: lang as any,
    });
    gather.say({ voice: ttsVoice as any }, finalReply);
    twiml.redirect(respondUrl);
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

interface MulterRequest extends Request {
  file?: any;
}

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max
  }
});

// API: Upload to Cloudinary (General)
app.post("/api/upload", upload.single("file"), async (req: any, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file provided" });

    const b64 = Buffer.from(file.buffer).toString("base64");
    const dataURI = "data:" + file.mimetype + ";base64," + b64;
    
    const result = await cloudinary.uploader.upload(dataURI, {
      resource_type: "auto",
    });

    res.json({ url: result.secure_url });
  } catch (error) {
    res.status(500).json({ error: "Upload failed" });
  }
});

// API: Upload Voice Note to Cloudinary as MP3
app.post("/api/upload-audio", upload.single("audio"), async (req: any, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No audio file provided" });

    const b64 = Buffer.from(file.buffer).toString("base64");
    const mime = file.mimetype || "audio/webm";
    const dataURI = `data:${mime};base64,${b64}`;

    // Upload to Cloudinary with format mp3 & resource_type video
    const result = await cloudinary.uploader.upload(dataURI, {
      resource_type: "video",
      format: "mp3",
      folder: "voxassist_voice_notes",
    });

    console.log("[Cloudinary Audio Upload] Saved MP3 voice note:", result.secure_url);
    res.json({ url: result.secure_url, format: "mp3" });
  } catch (error: any) {
    console.error("Audio upload error:", error);
    res.status(500).json({ error: error.message || "Failed to upload audio" });
  }
});

// API: Process PDF or Image with Multimodal OCR & Recognition
app.post("/api/process-document", upload.single("file"), async (req: MulterRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    let content = "";
    const fileType = req.file.mimetype || "application/octet-stream";
    const originalName = req.file.originalname || "document";

    if (fileType === "application/pdf" || originalName.toLowerCase().endsWith(".pdf")) {
      try {
        const pdfModule = await import("pdf-parse");
        const pdfParser = (pdfModule as any).default || pdfModule;
        const data = await pdfParser(req.file.buffer);
        content = data.text || "";
      } catch (err: any) {
        console.warn("pdf-parse extraction failed:", err?.message);
      }
    } else if (fileType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|heic|tiff)$/i.test(originalName)) {
      // 1. Run local Tesseract OCR
      try {
        const ocrResult = await Tesseract.recognize(req.file.buffer, 'eng');
        const rawOcrText = ocrResult?.data?.text || "";
        if (rawOcrText.trim()) {
          // Format & clean up OCR text if LLM is available
          const structuredText = await runLLMGeneration({
            system: "You are an AI document formatter. Reorganize and clean up raw OCR text into structured Markdown with clear headings, menu item names, prices, ingredients, descriptions, and policies. Do not invent any facts.",
            prompt: `Clean and format this raw OCR text:\n\n${rawOcrText}`,
          });
          content = structuredText || rawOcrText;
        }
      } catch (ocrErr: any) {
        console.warn("Tesseract OCR fallback failed, attempting vision model:", ocrErr?.message);
      }

      // 2. If Tesseract didn't get text, try multimodal LLM
      if (!content.trim()) {
        try {
          content = await runLLMGeneration({
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Exhaustively extract and transcribe all text, menu items, prices, policies, and details from this image in clean Markdown.' },
                { type: 'image', image: req.file.buffer }
              ]
            }]
          });
        } catch (visionErr: any) {
          console.warn("Vision LLM failed:", visionErr?.message);
        }
      }
    } else if (fileType === "text/plain" || fileType === "text/markdown" || fileType === "text/csv" || /\.(txt|md|csv|json)$/i.test(originalName)) {
      content = req.file.buffer.toString("utf-8");
    } else {
      content = req.file.buffer.toString("utf-8");
    }

    if (!content.trim()) {
      return res.status(400).json({ error: "Could not extract readable text from the uploaded file. Please ensure the image is clear and contains text." });
    }

    res.json({ 
      content: content.trim(), 
      sourceName: originalName,
      charCount: content.trim().length,
      mimeType: fileType,
    });
  } catch (error: any) {
    console.error("Error processing document:", error);
    res.status(500).json({ error: error.message || "Failed to process document" });
  }
});

// Helper to strip all emojis and symbols from text before TTS so they are never read out
function stripEmojis(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F910}-\u{1F96B}\u{1F980}-\u{1F9E0}\u{2B50}\u{2B55}\u{231A}\u{23F0}\u{23F3}\u{25AA}\u{25AB}\u{25FB}-\u{25FE}\u{FE0E}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[*#_`~\[\]\(\)]/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Convert any text into clean speakable plain sentences: no emojis, no markdown,
// no table pipes, and no symbols (&, ^, | ...) that a TTS engine would read aloud.
function sanitizeSpeechText(text: string): string {
  if (!text) return '';
  return expandSpokenAbbreviations(
    stripEmojis(text)
      .replace(/&/g, ' and ')
      .replace(/[|^\\>]/g, ' ')
      .replace(/[•●◦▪▫►◄★☆✦✧]/gu, ' ')
      .replace(/[“”]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// Detect the dominant language of a text by its script. Kannada uses the
// Unicode block \u0C80-\u0CFF and Hindi/Devanagari uses \u0900-\u097F.
// Anything without those blocks is treated as English.
function detectTextLanguage(text: string): "Kannada" | "Hindi" | "English" {
  if (!text) return "English";
  let kannada = 0;
  let devanagari = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (code >= 0x0c80 && code <= 0x0cff) kannada++;
    else if (code >= 0x0900 && code <= 0x097f) devanagari++;
  }
  if (kannada > devanagari && kannada > 0) return "Kannada";
  if (devanagari > 0) return "Hindi";
  return "English";
}

// Convert an app language code ('kn-IN' / 'hi-IN' / 'en-IN') to the display
// name used by the rest of the app ('Kannada' / 'Hindi' / 'English').
function languageNameOf(code: string): string {
  const c = (code || "").toLowerCase();
  if (c.startsWith("kn")) return "Kannada";
  if (c.startsWith("hi")) return "Hindi";
  return "English";
}

// Expand short-form words that look odd on screen and are read awkwardly by a
// TTS engine. Users explicitly asked for full conversational words: write
// "ಉದಾಹರಣೆಗೆ" instead of "ಉದಾ" and "example" instead of "ex"/"e.g.". Only whole
// tokens are replaced so normal words (e.g. "next", "example") are untouched.
function expandSpokenAbbreviations(text: string): string {
  if (!text) return '';
  return text
    // Kannada: ಉದಾ / ಉದಾ. → ಉದಾಹರಣೆಗೆ (for example)
    .replace(/\bಉದಾ\.?(ಗೆ)?\b/gu, 'ಉದಾಹರಣೆಗೆ')
    // English/GLOBAL short forms
    .replace(/\b(?:e\.g\.?|eg\.?|ex\.?)\b/gi, 'example')
    .replace(/\bi\.e\.?\b/gi, 'that is')
    .replace(/\betc\.?\b/gi, 'and so on')
    .replace(/\bvs\.?\b/gi, 'versus')
    .replace(/\bapprox\.?\b/gi, 'approximately')
    .replace(/\bfig\.?\b/gi, 'figure')
    .replace(/\bref\.?\b/gi, 'reference')
    .replace(/\bmin\.?\b/gi, 'minutes')
    .replace(/\bmax\.?\b/gi, 'maximum')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strict language guard for spoken replies. If the text is not written in the
// requested language, ask the LLM once to produce a clean, natural translation
// so the caller/reader never receives an answer in the wrong language.
async function enforceLanguage(text: string, desiredLang: string): Promise<string> {
  if (!text || !text.trim()) return text;
  const target = languageNameOf(desiredLang);
  if (target === "English" || detectTextLanguage(text) === target) return text;
  const fixed = await runLLMGeneration({
    system: `You are a professional, careful translator for a customer helpline.\nTranslate the text below into ${target} ONLY. Write in natural, plain, conversational ${target} exactly how a polite human would speak. Use FULL words only: never abbreviations such as "ಉದಾ", "ex", "e.g.", "i.e.", "etc.". Keep numbers, IDs, names and places exactly as given. Output ONLY the translated text with no explanations, quotes, or extra words.`,
    prompt: text,
  });
  if (fixed && detectTextLanguage(fixed) === target) return fixed.trim();
  return text;
}

// Helper: which required complaint detail is still missing (used to build the
// single targeted question instead of repeating a fixed one).
function firstMissingDetail(data: { cause?: string; location?: string; when?: string }): "location" | "when" | "cause" | null {
  if (!data?.location || !String(data.location).trim() || /unknown/i.test(String(data.location))) return "location";
  if (!data?.when || !String(data.when).trim() || /unknown/i.test(String(data.when))) return "when";
  if (!data?.cause || !String(data.cause).trim() || /unknown/i.test(String(data.cause))) return "cause";
  return null;
}

// Extract the first balanced JSON object from an LLM reply, ignoring any
// surrounding prose or ```json code fences (strict parsers choke on those).
function extractJsonBlock(text: string): string {
  if (!text) return '';
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return t;
  return t.slice(start, end + 1);
}

// Map app language names/codes to Sarvam TTS language codes
function sarvamLangCode(language: string): string {
  const l = (language || '').toLowerCase();
  if (l.includes('kn') || l.includes('kannada')) return 'kn-IN';
  if (l.includes('hi') || l.includes('hindi')) return 'hi-IN';
  return 'en-IN';
}

// ---------------------------------------------------------------------------
// FREE & FAST TTS (no API key, no credits): Microsoft Edge "Read Aloud" neural
// voices served through the MIT-licensed `msedge-tts` npm package. Includes
// natural Kannada (kn-IN-SapnaNeural/GaganNeural), Hindi (hi-IN-SwaraNeural/
// MadhurNeural) and Indian English (en-IN-NeerjaNeural/PrabhatNeural) voices,
// with low latency. This is the DEFAULT provider so the app speaks even with
// zero Sarvam credits. Sarvam AI stays as an optional fallback.
// ---------------------------------------------------------------------------
function edgeTTSVoice(language: string): string {
  const l = String(language || '').toLowerCase();
  if (l.includes('kn') || l.includes('kannada')) return process.env.TTS_EDGE_VOICE_KN || "kn-IN-SapnaNeural";
  if (l.includes('hi') || l.includes('hindi')) return process.env.TTS_EDGE_VOICE_HI || "hi-IN-SwaraNeural";
  return process.env.TTS_EDGE_VOICE_EN || "en-IN-NeerjaNeural";
}

async function edgeTextToSpeech(text: string, language: string): Promise<{ audioBase64: string; voice: string } | null> {
  try {
    // Non-literal specifier so tsc does not hard-require the package to be
    // installed at type-check time (it is declared in package.json and loaded
    // lazily at runtime; run `npm install` before first use).
    const edgePkg = "msedge-tts";
    const mod: any = await import(edgePkg);
    const MsEdgeTTS = mod.MsEdgeTTS || mod.default;
    if (!MsEdgeTTS) {
      console.warn("[TTS] msedge-tts package not available.");
      return null;
    }
    const tts = new MsEdgeTTS();
    const voice = edgeTTSVoice(language);
    // PCM WAV output keeps the same /api/tts contract as the old Sarvam path.
    await tts.setMetadata(voice, "riff-24khz-16bit-mono-pcm");

    const clean = sanitizeSpeechText(text).slice(0, 900);
    if (!clean) return null;

    const result: any = tts.synthesize(clean, { rate: 0, pitch: 0, volume: 0 });
    const stream = result?.audio;
    if (!stream) return null;

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    try { if (typeof (tts as any).close === "function") await (tts as any).close(); } catch {}

    if (chunks.length === 0) return null;
    return { audioBase64: Buffer.concat(chunks).toString("base64"), voice };
  } catch (e: any) {
    console.warn("[TTS] Edge TTS notice:", e?.message);
    return null;
  }
}

// High-fidelity neural TTS via Sarvam AI: natural, human-sounding Indian voices
// for English, Hindi and Kannada. Returns base64 WAV audio or null on failure.
async function sarvamTextToSpeech(text: string, language: string): Promise<string | null> {
  const apiKey = process.env.SARVAM_API_KEY;
  const clean = sanitizeSpeechText(text);
  if (!apiKey || apiKey === "YOUR_SARVAM_API_KEY" || !clean) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey,
      },
      body: JSON.stringify({
        target_language_code: sarvamLangCode(language),
        speaker: process.env.SARVAM_TTS_SPEAKER || "aditya",
        model: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
        speech_sample_rate: 22050,
        inputs: [clean.slice(0, 900)],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    const audio = data?.audios?.[0];
    return typeof audio === "string" && audio.length > 100 ? audio : null;
  } catch (e: any) {
    console.warn("Sarvam TTS notice:", e?.message);
    return null;
  }
}

// Helper to generate & upload TTS audio to Cloudinary for instant playback
async function generateTTSAudioUrl(text: string, language: string): Promise<string | null> {
  // Audio is synthesized on demand through /api/tts (Sarvam), so no pre-generated URL is stored.
  return null;
}

// API: Chat with Assistant (Grounding on recognized knowledge base & zero-delay QA cache)
app.post("/api/chat", async (req, res) => {
  const { message, context, language, profile, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  const queryText = message.trim();
  const targetLang = language || "English";

  // LANGUAGE LOCK: always reply in the language the citizen actually used.
  // If their message is written/spoken in Kannada or Hindi script while the
  // UI/app language is English, we switch to their language so nobody ever
  // receives an English answer after speaking Kannada.
  const messageScriptLang = detectTextLanguage(queryText);
  const languageOverridden = messageScriptLang !== "English" && messageScriptLang !== targetLang;
  const finalLang = languageOverridden ? messageScriptLang : targetLang;

  // 1. Check Turso DB qa_cache for pre-computed / cached intent answers
  //    (skipped when the language was overridden so an English cached answer
  //    is never served to a Kannada/Hindi speaker)
  try {
    const turso = getTurso();
    if (turso && !languageOverridden) {
      const cacheRes = await turso.execute({
        sql: "SELECT * FROM qa_cache WHERE language = ? ORDER BY created_at DESC LIMIT 40",
        args: [targetLang]
      });

      if (cacheRes && cacheRes.rows && cacheRes.rows.length > 0) {
        const rows = cacheRes.rows as any[];
        
        // Exact normalized string match check (only for long specific FAQs)
        const cleanUserQ = queryText.toLowerCase().replace(/[^a-z0-9\u0900-\u097F\u0C80-\u0CFF]/g, '').trim();
        let matchedRow = cleanUserQ.length > 10 ? rows.find(r => {
          const cleanQ = String(r.question || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097F\u0C80-\u0CFF]/g, '').trim();
          return cleanQ === cleanUserQ;
        }) : null;

        if (matchedRow) {
          console.log(`[QA Cache Hit] Pre-generated answer used for: "${queryText}" -> Matched: "${matchedRow.question}"`);
          let audioUrl = matchedRow.audio_url;
          if (!audioUrl) {
            audioUrl = await generateTTSAudioUrl(matchedRow.answer, targetLang);
            if (audioUrl && turso) {
              turso.execute({
                sql: "UPDATE qa_cache SET audio_url = ? WHERE id = ?",
                args: [audioUrl, matchedRow.id]
              }).catch(() => {});
            }
          }
          return res.json({
            response: sanitizeSpeechText(matchedRow.answer),
            audioUrl: audioUrl || null,
            cached: true,
            isComplaintDraft: false
          });
        }
      }
    }
  } catch (cacheErr: any) {
    console.warn("Turso QA cache query notice:", cacheErr?.message);
  }

  try {
    let effectiveContext = context || "";

    // If context not passed from client, query Turso directly
    if (!effectiveContext.trim()) {
      try {
        const turso = getTurso();
        const kbResult = await turso.execute("SELECT name, content FROM knowledge_base ORDER BY createdAt DESC");
        effectiveContext = kbResult.rows.map(r => `--- ${r.name} ---\n${r.content}`).join("\n\n");
      } catch (dbErr: any) {
        console.warn("Could not load knowledge from Turso in /api/chat:", dbErr?.message);
      }
    }

    const turnCount = Number(req.body.chatCount) || (Array.isArray(history) ? Math.floor(history.length / 2) + 1 : 1);

    const systemPrompt = `You are VoxAssist's expert AI Food Safety, Hygiene, and Standards Inspection Authority Assistant.
You represent the Official Government Food Safety & Hygiene Consumer Grievance Portal.
You are NOT a restaurant, food ordering service, or menu assistant. Do NOT offer menus or food ordering.

Citizen Profile:
- Name: ${profile?.name || "Citizen"}
- Phone: ${profile?.phone || "Not provided"}
- Location: ${profile?.location || "Not specified"}

KNOWLEDGE BASE & REGULATORY DIRECTIVES:
"""
${effectiveContext || "Standard FSSAI Food Safety & Standards Guidelines apply."}
"""

TARGET RESPONSE LANGUAGE: ${finalLang}.

STRICT CONVERSATION & RESPONSE RULES:
1. INFORMATIONAL QUESTIONS:
   - If the citizen asks a question about food safety regulations, FSSAI licensing, hygiene inspection rules, adulteration testing, food safety laws, or penalties, answer directly, precisely, and accurately with statutory guidance in the requested language (${finalLang}).
   - Use polite, respectful honorifics ONLY when the target language is Kannada (ನಮಸ್ಕಾರ, ದಯವಿಟ್ಟು, ತಾವು, ತಮ್ಮ, ಸವಿನಯವಾಗಿ) or Hindi (नमस्ते, कृपया). NEVER open an English reply with Kannada or Hindi greetings.

LANGUAGE LOCK (MOST IMPORTANT):
   - You MUST write your whole reply ONLY in ${finalLang} — never mix in another language, never answer English to a Kannada or Hindi speaker, and never apologize for the language.

SPOKEN-WORD RULES (replies are read aloud by a voice assistant):
   - Speak like a helpful human in short, natural, conversational sentences. In Kannada write full respectful words, for example "ಉದಾಹರಣೆಗೆ" not "ಉದಾ"; never write "ex", "e.g.", "i.e.", "etc.", "vs", "b/w" — always write full words (example / for example / that is / and so on / between).

3. ANSWER FORMAT (CRITICAL — replies are read aloud by a voice assistant):
   - Answer in natural, plain, conversational sentences, exactly like a helpful human advisor speaking — never in a robotic or bullet style.
   - NEVER use emojis, markdown symbols (hash, star, underscore, backtick, pipe, greater-than, tilde), tables, or characters like ^ and & anywhere in a normal reply.
   - NEVER create tables for responses. If details are needed, put them into natural sentences.
   - USE THE CONVERSATION MEMORY: you are given the recent chat history. Never repeat the citizen's own words back, never ask for something they already told you, and never ask the same question twice.
   - Do not ask generic repeated questions such as "How may I assist you?" or "Is there anything else?" after the citizen has already asked something.
   - Do not interrogate the citizen: if they describe a full situation in one message, acknowledge it and continue. Ask only for a genuinely missing required detail (place, time, or what went wrong), at most ONE question at a time, and never ask the same question twice.
   - If a complaint detail is still missing after the citizen tried to answer once, or their message cannot be understood, do NOT keep asking the same question. Instead, politely tell them (in ${finalLang}) that they can add a clear PHOTO of the food, packet, bill or location to speed up help, and continue with whatever details you already have.

2. COMPLAINT & GRIEVANCE REPORTING FLOW:
   - When the citizen reports a specific food safety violation, unhygienic restaurant/vendor, spoiled/contaminated food, food poisoning incident, or foreign object (insects, hair, glass, chemical odor):
     a) Express high empathy and serious concern for consumer health in plain language.
     b) Note down the incident details: WHERE (outlet/vendor/location), WHEN (date & time), and CAUSES/VIOLATIONS (symptoms, items, contamination details).
     c) If key details are missing, ask for them politely one by one.
     d) Once details are clear, first write one short reassuring sentence, then generate the official Food Safety Grievance Report using the Markdown structure below, and append COMPLAINT_DRAFT_REQUEST at the end.

HIGHLY DESIGNED MARKDOWN FOOD SAFETY GRIEVANCE REPORT STRUCTURE:
# 📋 Official Food Safety & Inspection Grievance Report
> **Reference ID:** #FS-${Date.now().toString().slice(-6)} | **Authority:** Food Safety Inspection Division | **Priority:** Urgent | **Status:** Logged for Enforcement

---

### 📍 Incident & Inspection Summary
| Parameter | Details |
| :--- | :--- |
| **Complainant Name** | ${profile?.name || "Valued Citizen"} |
| **Contact Phone** | ${profile?.phone || "Registered Phone"} |
| **Establishment / Location (WHERE)** | [Extracted Location/Branch] |
| **Incident Date & Time (WHEN)** | [Extracted Date/Time] |
| **Target Food Product** | [Extracted Food Item] |
| **Violation / Contamination (CAUSE)** | [Extracted Cause/Violation] |
| **Logged Timestamp** | ${new Date().toLocaleString()} |

---

### 🔍 Technical Violation Breakdown
[Detailed explanation of the reported contamination, hygiene failure, or health hazard]

### ⚠️ FSSAI Compliance Risk Assessment
- **Food Safety Hazard Level:** Severe risk to public health and consumer safety.
- **Enforcement Priority:** Immediate inspection dispatch recommended under Food Safety Act.

### 📌 Enforcement Directive
1. Urgent spot-check inspection by Food Safety Officer (FSO).
2. Sample seizure and food testing laboratory dispatch.
3. Show-cause notice issued to the establishment management.

---
*Report issued by Food Safety Governance Protocol*`;

    const conversationHistory = Array.isArray(history) && history.length > 0
      ? history.slice(-12).map((h: any) => ({
          role: (h.role === "assistant" || h.sender === "assistant") ? "assistant" : "user",
          content: String(h.content || h.text || "")
        }))
      : [];

    const fullMessages = [
      ...conversationHistory,
      { role: "user", content: message }
    ];

    let responseText = await runLLMGeneration({
      system: systemPrompt,
      messages: fullMessages,
    });

    // Guaranteed natural fallback response if keys fail
    if (!responseText) {
      if (finalLang === 'Kannada') {
        responseText = "ನಮಸ್ಕಾರ! ಇದು ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ನೈರ್ಮಲ್ಯ ಪರಿಶೀಲನೆ ಸಹಾಯವಾಣಿ. ಇಂದು ನಿಮ್ಮ ಆಹಾರ ಸುರಕ್ಷತಾ ದೂರಿಗೆ ನಾನು ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?";
      } else if (finalLang === 'Hindi') {
        responseText = "नमस्ते! यह खाद्य सुरक्षा एवं स्वच्छता निरीक्षण हेल्पलाइन है। आज आपकी खाद्य सुरक्षा या शिकायत दर्ज करने में मैं कैसे सहायता कर सकता हूँ?";
      } else {
        responseText = "Greetings! This is the Food Safety & Inspection Authority Helpline. How may I assist you with your food safety or hygiene grievance today?";
      }
    }

    const isComplaintDraft = responseText.includes("COMPLAINT_DRAFT_REQUEST");
    let cleanedText = responseText.replace(/COMPLAINT_DRAFT_REQUEST/g, "").trim();

    let spokenPart = cleanedText;
    let markdownPart = "";

    if (cleanedText.includes("# 📋") || cleanedText.includes("Official Consumer Grievance")) {
      const parts = cleanedText.split(/(?=# 📋|# Official Consumer Grievance)/);
      if (parts.length > 1 && parts[0].trim().length > 10) {
        spokenPart = parts[0].trim();
        markdownPart = parts.slice(1).join("").trim();
      } else {
        markdownPart = cleanedText;
        const customerName = profile?.name ? ` ${profile.name}` : "";
        if (finalLang === 'Kannada') {
          spokenPart = `ನಾವು ಮುಂದಿನ ಕ್ರಮವನ್ನು ಕೈಗೊಳ್ಳುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು${customerName}! ಬೈ${customerName}, ತಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ!`;
        } else if (finalLang === 'Hindi') {
          spokenPart = `हम आगे की उचित कार्रवाई करेंगे। धन्यवाद${customerName}! बाय${customerName}, आपका दिन शुभ हो!`;
        } else {
          spokenPart = `We will take care further. Thank you${customerName}! Bye${customerName}, have a nice day!`;
        }
      }
    }

    // Normal answers must be clean, plain, speakable text (no emojis, markdown,
    // tables, or symbols). Complaint drafts keep their structured report format.
    if (!isComplaintDraft) {
      cleanedText = sanitizeSpeechText(cleanedText);
      spokenPart = cleanedText;

      // LANGUAGE GUARD: never hand an English answer to a Kannada/Hindi citizen.
      // If the model slipped into the wrong language, retranslate it once.
      const guarded = await enforceLanguage(cleanedText, finalLang);
      if (guarded !== cleanedText) {
        cleanedText = guarded;
        spokenPart = guarded;
        console.log(`[Chat] Reply language corrected to ${finalLang}`);
      }
    }

    // Generate audio for fast playback & Cloudinary storage using spoken portion
    const audioUrl = await generateTTSAudioUrl(spokenPart.slice(0, 450), finalLang);

    // Save newly generated Q&A pair into Turso DB qa_cache
    try {
      const turso = getTurso();
      if (turso && cleanedText && !isComplaintDraft) {
        const newId = `qa_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        turso.execute({
          sql: `INSERT INTO qa_cache (id, normalized_intent, language, question, answer, audio_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [newId, "general_query", finalLang, queryText, cleanedText, audioUrl || "", Date.now()]
        }).catch(() => {});
      }
    } catch (dbSaveErr: any) {
      console.warn("Save to qa_cache notice:", dbSaveErr?.message);
    }

    res.json({ 
      response: cleanedText, 
      spokenText: spokenPart,
      markdownReport: markdownPart,
      audioUrl, 
      isComplaintDraft, 
      cached: false,
      detectedLanguage: finalLang
    });
  } catch (error: any) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message || "Failed to process chat" });
  }
});

// API: Dedicated Calm & Pleasant IVR Dialogue State Machine
app.post("/api/ivr/dialogue", async (req, res) => {
  const { 
    message, 
    digits, 
    step = "welcome", 
    language = "en-IN", 
    profile, 
    collectedData = {}, 
    history = [],
    audioNoteUrl,
    isVoiceNote
  } = req.body;

  let currentLang = language;
  let nextStep = step;
  let replyText = "";
  let updatedData = { ...collectedData };
  if (audioNoteUrl) {
    updatedData.audioNoteUrl = audioNoteUrl;
  }
  let isComplaintReady = false;
  let markdownReport = "";

  const isKannada = currentLang === "kn-IN" || currentLang === "Kannada";
  const isHindi = currentLang === "hi-IN" || currentLang === "Hindi";

  // Recent conversation memory (what the caller said and what the IVR answered)
  // so the assistant never repeats a question or forgets already-given details.
  const dialogueHistory = Array.isArray(history) && history.length > 0
    ? history.slice(-10).map((h: any) => {
        const who = (h.role === "user" || h.sender === "user" || h.sender === "caller") ? "Caller" : "Assistant";
        return `${who}: ${String(h.content || h.text || "")}`;
      }).join("\n")
    : "No previous conversation.";

  // Read the last assistant question so we can detect a question that is about
  // to be repeated (which angers callers) and switch to photo guidance instead.
  const lastAssistantTurn = (Array.isArray(history) ? [...history].reverse().find((h: any) =>
    h.role === "assistant" || h.sender === "assistant" || h.sender === "ivr") : null);
  const lastAssistantText = lastAssistantTurn ? String((lastAssistantTurn as any).content || (lastAssistantTurn as any).text || "") : "";

  const ivrPhotoGuidance = (): string => {
    if (isKannada) {
      return "ಕ್ಷಮಿಸಿ, ತಮ್ಮ ಮಾತು ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸುತ್ತಿಲ್ಲ. ಸಮಸ್ಯೆಯ ಆಹಾರ, ಪ್ಯಾಕೇಜ್ ಅಥವಾ ಬಿಲ್ ನ ಫೋಟೋ ಇದ್ದರೆ, Talk ಚಾಟ್ ನಲ್ಲಿ ಫೋಟೋ ಸೇರಿಸಿದರೆ ನಮ್ಮ ತಂಡ ಬೇಗನೆ ಸಹಾಯ ಮಾಡುತ್ತದೆ. ಈಗ ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ, ಅಥವಾ ಮತ್ತೊಮ್ಮೆ ನಿಧಾನವಾಗಿ ಹೇಳಿ.";
    }
    if (isHindi) {
      return "माफ़ कीजिए, आपकी आवाज़ स्पष्ट नहीं आ रही है। समस्या के भोजन, पैकेट या बिल की फोटो हो तो उसे Talk चैट में जोड़ें, हमारी टीम जल्द मदद करेगी। शिकायत दर्ज करने के लिए 9 दबाएँ या एक बार धीरे-धीरे फिर से बोलें।";
    }
    return "Sorry, I could not hear you clearly. If you have a photo of the food, packet or bill, please add it in the Talk chat so our team can help faster. To submit your complaint now press 9, or try once more slowly.";
  };

  // True when the question we are about to ask was already asked immediately
  // before — a sign the caller's answer was not understood.
  const repeatsLastQuestion = (missing: string): boolean => {
    if (!lastAssistantText) return false;
    if (missing === "location") return /(location|restaurant|shop|place|ಸ್ಥಳ|ಹೋಟೆಲ್|ಅಂಗಡಿ|रेस्टोरेंट|दुकान|स्थान|hotel|store)/i.test(lastAssistantText);
    if (missing === "when") return /(when|day|time|date|ಯಾವ ದಿನ|ಸಮಯ|ದಿನಾಂಕ|दिन|समय|तारीख)/i.test(lastAssistantText);
    return /(problem|what went wrong|describe|cause|ಸಮಸ್ಯೆ|ಏನು|ಕಾರಣ|समस्या|क्या|कारण)/i.test(lastAssistantText);
  };

  try {
    // 1. DTMF Language Selection (1 = Kannada, 2 = Hindi, 3 = English)
    if (digits === "1" || (step === "welcome" && (/1|one|kannada|ಕನ್ನಡ|ಒಂದು/i.test(message || "")))) {
      currentLang = "kn-IN";
      nextStep = "collecting_info";
      replyText = "ನಮಸ್ಕಾರ! ದಯವಿಟ್ಟು ನಿಮ್ಮ ಆಹಾರ ಸುರಕ್ಷತೆ ಅಥವಾ ನೈರ್ಮಲ್ಯ ದೂರನ್ನು ವಿವರವಾಗಿ ತಿಳಿಸಿ.";
    } else if (digits === "2" || (step === "welcome" && (/2|two|hindi|हिंदी|हिन्दी|दो|ಎರಡು/i.test(message || "")))) {
      currentLang = "hi-IN";
      nextStep = "collecting_info";
      replyText = "नमस्ते! कृपया अपनी खाद्य सुरक्षा या स्वच्छता संबंधी समस्या विस्तार से बताएं।";
    } else if (digits === "3" || (step === "welcome" && (/3|three|english|ಇಂಗ್ಲಿಷ್|ಮೂರು|तीन/i.test(message || "")))) {
      currentLang = "en-IN";
      nextStep = "collecting_info";
      replyText = "Hello! Please describe your food safety or hygiene issue in detail.";
    } 
    // 2. DTMF Key 7: Press 7 for Audio Voice Note Recording
    else if ((digits === "7" || /7|seven|record|voice note|audio note|ಧ್ವನಿ|ರೆಕಾರ್ಡ್|ಏಳು|ऑडियो|सात/i.test(message || "")) && !isVoiceNote && step !== "ready_for_beep") {
      nextStep = "ready_for_beep";
      if (isKannada) {
        replyText = "ದಯವಿಟ್ಟು ಬೀಪ್ ಶಬ್ದದ ನಂತರ ತಮ್ಮ ವಿವರವಾದ ಧ್ವನಿ ಸಂದೇಶವನ್ನು ಸ್ಪಷ್ಟವಾಗಿ ಮಾತನಾಡಿ.";
      } else if (isHindi) {
        replyText = "कृपया बीप की आवाज़ के बाद अपना विस्तृत ऑडियो संदेश रिकॉर्ड करें।";
      } else {
        replyText = "Please record your message after the beep.";
      }
    }
    // 2b. Reaction to Recorded Voice Note
    else if (isVoiceNote || step === "ready_for_beep") {
      nextStep = "press_7_prompt";
      if (message && message !== "Voice note recorded and attached." && message !== "Voice note recorded.") {
        const prompt = `The customer just recorded a voice note describing their food complaint.
Voice note transcript: "${message}"
Language: ${currentLang}
Known details:
- Cause: ${updatedData.cause || "Unknown"}
- Location: ${updatedData.location || "Unknown"}
- When: ${updatedData.when || "Unknown"}
- Item: ${updatedData.item || "Unknown"}

Conversation so far (memory — never re-ask what is already here):
${dialogueHistory}

Instructions:
1. Extract any newly mentioned cause (what went wrong/details), location/where (restaurant name, branch, address), when (date or time), or food item name.
2. Acknowledge what the caller spoke in their voice note in 1-2 calm, reassuring sentences.
3. Then state clearly: "To submit your complaint now, press 9 or say confirm." (in ${currentLang}).
4. Use polite Kannada/Hindi honorifics only when the language is Kannada or Hindi.
5. spokenResponse must be plain spoken words only: no emojis, no markdown, no symbols, no tables. Use FULL words only: never abbreviate (never write "ಉದಾ", "ex", "e.g.", "i.e.", "etc." — write ಉದಾಹರಣೆಗೆ / example / that is / and so on fully).
6. Never repeat details the customer already gave, and never ask for something already known.
7. Reply ONLY in ${currentLang === "kn-IN" ? "Kannada" : currentLang === "hi-IN" ? "Hindi" : "English"} — never mix languages.

Respond with ONLY valid JSON (no markdown code fences, no extra text):
{
  "cause": "updated or existing cause",
  "location": "updated or existing location",
  "when": "updated or existing when",
  "item": "updated or existing item",
  "spokenResponse": "1-2 highly polite sentences to speak to caller in ${currentLang}"
}`;

        try {
          const aiResponse = await runLLMGeneration({ prompt }) || "{}";
          const parsed = JSON.parse(extractJsonBlock(aiResponse));
          if (parsed.cause) updatedData.cause = parsed.cause;
          if (parsed.location) updatedData.location = parsed.location;
          if (parsed.when) updatedData.when = parsed.when;
          if (parsed.item) updatedData.item = parsed.item;
          if (parsed.spokenResponse) replyText = await enforceLanguage(parsed.spokenResponse, currentLang);
        } catch {}
      }

      if (!replyText) {
        if (isKannada) {
          replyText = "ಧನ್ಯವಾದಗಳು, ತಮ್ಮ ಧ್ವನಿ ಸಂದೇಶವನ್ನು ಸ್ವೀಕರಿಸಲಾಗಿದೆ ಮತ್ತು ದಾಖಲಿಸಲಾಗಿದೆ. ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ ಅಥವಾ ದೃಢೀಕರಿಸಿ ಎಂದು ಹೇಳಿ.";
        } else if (isHindi) {
          replyText = "धन्यवाद, आपकी ऑडियो रिकॉर्डिंग सुरक्षित कर ली गई है। शिकायत दर्ज करने के लिए 9 दबाएँ या पुष्टि करें कहें।";
        } else {
          replyText = "Thank you, your voice note has been recorded and attached. To submit your complaint, press 9 or say confirm.";
        }
      }
    }
    // 3. DTMF Key 9 or explicit user confirmation to submit
    else if (digits === "9" || (step === "press_7_prompt" && /9|nine|confirm|yes|submit|sari|ha|ದೃಢೀಕರಿಸಿ|ಒಂಬತ್ತು|दर्ज|पुष्टि|हाँ|नौ/i.test(message || ""))) {
      nextStep = "submitted";
      isComplaintReady = true;

      const caseId = `GRV-${Date.now().toString().slice(-6)}`;
      const cause = updatedData.cause || "Food hygiene & quality discrepancy";
      const location = updatedData.location || profile?.location || "Unspecified Branch";
      const item = updatedData.item || "Food Item";

      markdownReport = `# 📋 Official Consumer Grievance Report
> **Reference ID:** #${caseId} | **Channel:** IVR Helpline (1800-FOOD-VOX) | **Priority:** High | **Status:** Logged & Under Review

---

### 📍 Incident Specifics
| Parameter | Record Details |
| :--- | :--- |
| **Consumer Name** | ${profile?.name || "Valued Customer"} |
| **Contact Phone** | ${profile?.phone || "Phone On File"} |
| **Incident Location** | ${location} |
| **Affected Item** | ${item} |
| **Core Cause / Violation** | ${cause} |
| **Incident Timestamp** | ${new Date().toLocaleString()} |

---

### 🔍 Cause & Incident Breakdown
${cause}

### 🎙️ Audio Evidence
${updatedData.audioNoteUrl ? `**Voice Note Attached (MP3):** [Play Voice Evidence](${updatedData.audioNoteUrl})` : "No direct audio recording attached."}

### ⚠️ Safety & Compliance Protocol
- **Hygiene & Safety Assessment:** Immediate compliance audit initiated.
- **Regulatory Framework:** FSSAI Schedule 4 Standards & Consumer Protection Act 2019.

### 📌 Corrective Actions
1. Immediate notification sent to outlet manager at ${location}.
2. Redressal & refund processing scheduled.
3. Audio recording and transcript archived for administrative review.

---
*Report filed via VoxAssist IVR Voice System*`;

      // Save into Turso database complaints table
      try {
        const turso = getTurso();
        if (turso) {
          await turso.execute({
            sql: `INSERT INTO complaints (id, name, phoneNumber, location, query, status, chatHistory, mediaUrls, audioUrl, createdAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              caseId,
              profile?.name || "IVR Caller",
              profile?.phone || "IVR Phone",
              location,
              markdownReport,
              "pending",
              JSON.stringify(history || []),
              "[]",
              updatedData.audioNoteUrl || "",
              Date.now()
            ]
          });
          console.log(`[IVR] Successfully registered complaint ${caseId} in Turso DB`);
        }
      } catch (dbErr: any) {
        console.warn("[IVR] Turso insert notice:", dbErr?.message);
      }

      if (isKannada) {
        replyText = `ನಿಮ್ಮ ದೂರು ಸಂಖ್ಯೆ ${caseId} ಯಶಸ್ವಿಯಾಗಿ ನೋಂದಾಯಿಸಲ್ಪಟ್ಟಿದೆ. ನಾವು ಮುಂದಿನ ಕ್ರಮವನ್ನು ಕೈಗೊಳ್ಳುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು, ${profile?.name || 'ಸ್ನೇಹಿತರೇ'}! ಬೈ ${profile?.name || ''}, ತಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ!`;
      } else if (isHindi) {
        replyText = `आपकी शिकायत संख्या ${caseId} सफलतापूर्वक दर्ज कर ली गई है। हम आगे की उचित कार्रवाई करेंगे। धन्यवाद, ${profile?.name || 'प्रिय ग्राहक'}! बाय ${profile?.name || ''}, आपका दिन शुभ हो!`;
      } else {
        replyText = `Your complaint reference ID ${caseId} has been successfully registered. We will take care further. Thank you, ${profile?.name || 'Valued Customer'}! Bye ${profile?.name || ''}, have a nice day!`;
      }
    }
    // 4. Ongoing conversation to collect information (Where, When, Cause)
    else {
      // Use LLM to extract cause, location, and when calmly, WITH full memory
      const prompt = `You are a calm, gentle, highly empathetic, and polite IVR Phone Agent for VoxAssist Consumer Helpline.
User profile: Name: ${profile?.name || "Caller"}, Phone: ${profile?.phone || "On File"}, Location: ${profile?.location || "Not given"}.
Currently known details:
- Cause: ${updatedData.cause || "Unknown"}
- Location/Where: ${updatedData.location || "Unknown"}
- When: ${updatedData.when || "Unknown"}
- Item: ${updatedData.item || "Unknown"}

Conversation so far (memory — never re-ask what is already in here):
${dialogueHistory}

Customer just said: "${message}"

Language: ${currentLang} (kn-IN for Kannada, hi-IN for Hindi, en-IN for English). Reply ONLY in ${currentLang === "kn-IN" ? "Kannada" : currentLang === "hi-IN" ? "Hindi" : "English"} — never mix languages.

Instructions:
1. Understand what the customer actually said and behave naturally from their words. Identify any newly mentioned cause (what went wrong/details), location/where (restaurant name, branch, address), when (date or time), or food item name.
2. The customer's answer is the main thing: if their message already supplies enough information, do NOT interrogate — acknowledge it and proceed to the next step.
3. Ask for a missing detail ONLY when it is genuinely missing, at most ONE question at a time, and NEVER ask again for anything already given in the conversation above.
4. When speaking Kannada, ALWAYS use polite and respectful honorifics (ನಮಸ್ಕಾರ, ದಯವಿಟ್ಟು, ತಾವು, ತಮ್ಮ, ಸವಿನಯವಾಗಿ, ತಿಳಿಸಿಕೊಡಿ, ಕ್ಷಮಿಸಿ). In English, never use Kannada or Hindi greetings.
5. If ALL THREE (Cause, Location/Where, and When) are now known:
   Calmly summarize the collected details and state:
   "If you would like to record a voice note, press 7. To submit your complaint now, press 9 or say confirm." (in the target language!).
6. Keep your spoken response to 1-2 calm, highly polite, reassuring sentences in plain words only (no emojis, no markdown, no symbols, no tables). Use FULL words only: never abbreviate (never write "ಉದಾ", "ex", "e.g.", "i.e.", "etc." — write ಉದಾಹರಣೆಗೆ / example / that is / and so on fully).
7. If you cannot identify any new detail from what the customer said, ask once gently to repeat slowly in plain words; never interrogate a second time.

Respond with ONLY valid JSON (no markdown code fences, no extra text):
{
  "cause": "updated or existing cause",
  "location": "updated or existing location",
  "when": "updated or existing when",
  "item": "updated or existing item",
  "spokenResponse": "1-2 highly polite sentences to speak to the caller in ${currentLang}",
  "hasRequiredDetails": true/false
}`;

      const aiResponse = await runLLMGeneration({ prompt }) || "{}";
      let parsed: any = {};
      try {
        parsed = JSON.parse(extractJsonBlock(aiResponse));
      } catch {
        parsed = {};
      }

      if (parsed.cause) updatedData.cause = parsed.cause;
      if (parsed.location) updatedData.location = parsed.location;
      if (parsed.when) updatedData.when = parsed.when;
      if (parsed.item) updatedData.item = parsed.item;

      const hasAllDetails = parsed.hasRequiredDetails || (updatedData.cause && updatedData.location && updatedData.when);

      if (hasAllDetails) {
        nextStep = "press_7_prompt";
        if (parsed.spokenResponse) {
          replyText = await enforceLanguage(parsed.spokenResponse, currentLang);
        } else {
          if (isKannada) {
            replyText = `ತುಂಬು ಹೃದಯದ ಧನ್ಯವಾದಗಳು. ತಮ್ಮ ದೂರನ್ನು ಸಿದ್ಧಪಡಿಸಲಾಗಿದೆ. ತಾವು ಸ್ವತಃ ಧ್ವನಿ ಸಂದೇಶ ರೆಕಾರ್ಡ್ ಮಾಡಲು ಬಯಸಿದರೆ 7 ಒತ್ತಿ, ಅಥವಾ ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ.`;
          } else if (isHindi) {
            replyText = `धन्यवाद। हमने विवरण नोट कर लिया है। यदि आप अपनी आवाज़ में संदेश रिकॉर्ड करना चाहते हैं तो 7 दबाएँ, अथवा शिकायत दर्ज करने के लिए 9 दबाएँ।`;
          } else {
            replyText = `Thank you. We have recorded your concern. If you would like to record a voice note, press 7. To submit your complaint, press 9 or say confirm.`;
          }
        }
      } else {
        nextStep = "collecting_info";
        const missing = firstMissingDetail(updatedData);
        const wouldRepeat = missing ? repeatsLastQuestion(missing) : false;

        if (parsed.spokenResponse && !wouldRepeat) {
          // LLM's natural acknowledgement + single targeted question (if any)
          replyText = await enforceLanguage(parsed.spokenResponse, currentLang);
        } else if (wouldRepeat) {
          // The same question was already asked and still not understood —
          // STOP interrogating. Guide the caller to add photos (failing case).
          replyText = ivrPhotoGuidance();
        } else if (missing) {
          // Ask ONLY the first genuinely missing field (location → when → cause)
          replyText = phoneMissingDetailQuestion(currentLang, missing);
        } else {
          replyText = isKannada
            ? "ಕ್ಷಮಿಸಿ, ತಮ್ಮ ಮಾತು ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ನಿಧಾನವಾಗಿ ಹೇಳಿ."
            : (isHindi ? "माफ़ कीजिए, आपकी आवाज़ स्पष्ट नहीं आई। कृपया धीरे-धीरे फिर से बोलें।" : "Sorry, I could not understand. Please speak slowly once more.");
        }
      }
    }

    // Speak/display clean plain text only (no emojis, symbols, or markdown)
    const cleanReply = sanitizeSpeechText(replyText);
    if (cleanReply) replyText = cleanReply;

    // Attempt to generate TTS (currently returns null, relying on browser TTS)
    const audioUrl = await generateTTSAudioUrl(replyText, currentLang);

    res.json({
      text: replyText,
      audioUrl,
      nextStep,
      language: currentLang,
      collectedData: updatedData,
      isComplaintReady,
      markdownReport
    });
  } catch (err: any) {
    console.error("[IVR Dialogue Error]", err);
    res.status(500).json({ error: err.message || "IVR dialogue error" });
  }
});

// API: Server Text-to-Speech — default FREE provider is Microsoft Edge neural
// voices via `msedge-tts` (no API key/credits, fast, Kannada/Hindi/English).
// Optional paid provider: Sarvam AI, used only when TTS_PROVIDER=sarvam or
// when the Edge provider fails and a Sarvam key is configured.
app.post("/api/tts", async (req, res) => {
  const { text, language } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  try {
    const cleanText = String(text).trim();
    const langLabel = String(language || "English");
    const providerMode = String(process.env.TTS_PROVIDER || "edge").toLowerCase();

    // 1. DEFAULT: free Microsoft Edge neural TTS (no token, no credits).
    if (providerMode !== "sarvam") {
      const edge = await edgeTextToSpeech(cleanText, langLabel);
      if (edge) {
        return res.json({ audioBase64: edge.audioBase64, format: "wav", provider: "edge", voice: edge.voice });
      }
    }

    // 2. OPTIONAL: Sarvam AI (paid / credits) as fallback when configured.
    const sarvamBase64 = await sarvamTextToSpeech(cleanText, langLabel);
    if (sarvamBase64) {
      return res.json({ audioBase64: sarvamBase64, format: "wav", provider: "sarvam" });
    }

    res.status(501).json({ error: "TTS unavailable right now. Please try again." });
  } catch (err: any) {
    console.error("TTS endpoint error:", err);
    res.status(500).json({ error: err.message || "TTS failed" });
  }
});

// Helper to detect Whisper hallucinations on silent/quiet audio clips
function isHallucinatedTranscript(text: string): boolean {
  if (!text || !text.trim()) return true;
  // Reject CJK (Chinese, Japanese, Korean) or Cyrillic characters returned as hallucinations
  if (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af\u0400-\u04FF]/.test(text)) {
    return true;
  }
  const clean = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const hallucinations = [
    "thank you",
    "thank you very much",
    "thank you so much",
    "thank you for watching",
    "thanks for watching",
    "thanks",
    "subtitles by amara org",
    "subtitles by amaraorg",
    "subtitles by",
    "amara org",
    "bye",
    "subscribe",
    "you",
    "mb",
    "silence",
    "noise",
    "dank u",
    "untertitel",
    "moje",
    "shokran"
  ];
  return hallucinations.includes(clean);
}

// API: Robust Multi-Tier Speech-to-Text (STT) - Sarvam AI + Groq Whisper + OpenAI
app.post("/api/stt", upload.single("audio"), async (req: any, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const { language } = req.body;
    const groqKey = process.env.GROQ_API_KEY;

    if (groqKey && groqKey !== "YOUR_GROQ_API_KEY") {
      try {
        const audioBuffer = req.file.buffer;
        const mime = req.file.mimetype || "audio/webm";

        // Only force a language when the caller EXPLICITLY chose Kannada/Hindi.
        // When the UI is English (or unknown) we let Whisper AUTO-DETECT, so a
        // Kannada/Hindi speaker who never switched the language is still
        // transcribed in their own language instead of mangled English.
        let forcedCode: string | null = null;
        const langInput = String(language || "").toLowerCase();
        if (langInput.includes("kannada") || langInput === "kn" || langInput === "kn-in") forcedCode = "kn";
        else if (langInput.includes("hindi") || langInput === "hi" || langInput === "hi-in") forcedCode = "hi";
        // NOTE: English is deliberately NOT forced.

        const attempts: (string | null)[] = forcedCode ? [forcedCode, null] : [null];

        for (const attemptLang of attempts) {
          const formData = new FormData();
          const fileObj = typeof File !== "undefined"
            ? new File([audioBuffer], "voice.webm", { type: mime })
            : new Blob([audioBuffer], { type: mime });
          formData.append("file", fileObj as any, "voice.webm");
          formData.append("model", "whisper-large-v3-turbo");
          if (attemptLang) formData.append("language", attemptLang);

          const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${groqKey}` },
            body: formData,
          });

          const contentType = groqRes.headers.get("content-type") || "";
          if (!contentType.includes("application/json")) continue;

          const groqData: any = await groqRes.json();
          const text = groqData?.text?.trim();

          if (text && !isHallucinatedTranscript(text)) {
            const detectedLanguage = detectTextLanguage(text);
            console.log(`[STT Success] Groq Whisper transcribed (${detectedLanguage}${attemptLang ? ", forced " + attemptLang : ", auto-detect"}): "${text}"`);
            return res.json({ transcript: text, detectedLanguage, provider: "groq-whisper" });
          }
          console.warn(`[STT] Attempt ${attemptLang || "auto"} produced empty/hallucinated text; retrying...`);
        }
      } catch (groqWhisperErr: any) {
        console.warn("Groq Whisper STT failed:", groqWhisperErr?.message);
      }
    }

    res.status(200).json({ transcript: "", detectedLanguage: "English", error: "Could not transcribe audio. Please speak closer to the microphone and try again." });
  } catch (err: any) {
    console.error("STT endpoint error:", err);
    res.status(200).json({ transcript: "", error: err.message });
  }
});

// API: Knowledge Base CRUD (Turso Database)
app.get("/api/knowledge", async (req, res) => {
  try {
    const turso = getTurso();
    if (!turso) return res.json([]);
    const result = await turso.execute("SELECT * FROM knowledge_base ORDER BY createdAt DESC");
    res.json(result.rows);
  } catch (error: any) {
    console.error("Error fetching knowledge from Turso:", error);
    res.status(500).json({ error: error.message, rows: [] });
  }
});

app.post("/api/knowledge", async (req, res) => {
  const { id, name, content, type, createdAt } = req.body;
  const docId = id || Date.now().toString();
  const docCreatedAt = createdAt || Date.now();
  try {
    const turso = getTurso();
    if (!turso) return res.json({ success: true, id: docId, name, content, type, createdAt: docCreatedAt });
    await turso.execute({
      sql: "INSERT INTO knowledge_base (id, name, content, type, createdAt) VALUES (?, ?, ?, ?, ?)",
      args: [docId, name || "Document", content || "", type || "text", docCreatedAt],
    });
    res.json({ success: true, id: docId, name, content, type, createdAt: docCreatedAt });
  } catch (error: any) {
    console.error("Error inserting knowledge into Turso:", error);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/knowledge/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const turso = getTurso();
    if (!turso) return res.json({ success: true, id });
    await turso.execute({
      sql: "DELETE FROM knowledge_base WHERE id = ?",
      args: [id],
    });
    res.json({ success: true, id });
  } catch (error: any) {
    console.error("Error deleting knowledge from Turso:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Store Complaint in Turso
app.post("/api/complaints/add", async (req, res) => {
  const { id, name, phoneNumber, location, query, status, chatHistory, mediaUrls, audioUrl, createdAt, adminReply, adminReplyAt } = req.body;
  
  try {
    const turso = getTurso();
    if (!turso) return res.json({ success: true, id });
    await turso.execute({
      sql: `INSERT INTO complaints (id, name, phoneNumber, location, query, status, chatHistory, mediaUrls, audioUrl, createdAt, adminReply, adminReplyAt) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id || Date.now().toString(), 
        name || "Guest", 
        phoneNumber || "N/A", 
        location || "", 
        query || "", 
        status || "pending", 
        typeof chatHistory === "string" ? chatHistory : JSON.stringify(chatHistory || []), 
        typeof mediaUrls === "string" ? mediaUrls : JSON.stringify(mediaUrls || []), 
        audioUrl || "", 
        createdAt || Date.now(),
        adminReply || "",
        adminReplyAt || null
      ],
    });
    res.json({ success: true, id });
  } catch (error: any) {
    console.error("Error saving complaint:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/complaints", async (req, res) => {
  const { phone, id } = req.query;
  try {
    const turso = getTurso();
    if (!turso) return res.json([]);
    if (id) {
      const result = await turso.execute({
        sql: "SELECT * FROM complaints WHERE id = ? ORDER BY createdAt DESC",
        args: [id as string],
      });
      return res.json(result.rows);
    }
    if (phone) {
      const cleanPhone = (phone as string).trim();
      const result = await turso.execute({
        sql: "SELECT * FROM complaints WHERE phoneNumber = ? OR phoneNumber LIKE ? ORDER BY createdAt DESC",
        args: [cleanPhone, `%${cleanPhone}%`],
      });
      return res.json(result.rows);
    }
    // Return empty list if no phone specified to prevent leaking other customers' private complaints
    res.json([]);
  } catch (error: any) {
    console.warn("Error fetching customer complaints:", error.message);
    res.status(500).json({ error: error.message, rows: [] });
  }
});

app.get("/api/admin/complaints", async (req, res) => {
  try {
    const turso = getTurso();
    if (!turso) return res.json([]);
    const result = await turso.execute("SELECT * FROM complaints ORDER BY createdAt DESC");
    res.json(result.rows);
  } catch (error: any) {
    console.error("Error fetching admin complaints:", error);
    res.status(500).json({ error: error.message, rows: [] });
  }
});

// Admin: Reply to complaint
app.post("/api/admin/complaints/:id/reply", async (req, res) => {
  const { id } = req.params;
  const { reply, status } = req.body;
  try {
    const turso = getTurso();
    const replyAt = Date.now();
    const newStatus = status || "resolved";
    await turso.execute({
      sql: "UPDATE complaints SET adminReply = ?, adminReplyAt = ?, status = ? WHERE id = ?",
      args: [reply, replyAt, newStatus, id],
    });
    res.json({ success: true, id, adminReply: reply, adminReplyAt: replyAt, status: newStatus });
  } catch (error: any) {
    console.error("Error updating complaint reply:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Update status
app.patch("/api/admin/complaints/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const turso = getTurso();
    await turso.execute({
      sql: "UPDATE complaints SET status = ? WHERE id = ?",
      args: [status, id],
    });
    res.json({ success: true, id, status });
  } catch (error: any) {
    console.error("Error updating complaint status:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete single or batch knowledge entries from Turso
app.post("/api/knowledge/batch-delete", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "IDs array is required" });
  }
  try {
    const turso = getTurso();
    for (const id of ids) {
      await turso.execute({
        sql: "DELETE FROM knowledge_base WHERE id = ?",
        args: [id],
      });
    }
    res.json({ success: true, count: ids.length });
  } catch (error: any) {
    console.error("Turso delete knowledge error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete complaint
app.delete("/api/admin/complaints/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const turso = getTurso();
    await turso.execute({
      sql: "DELETE FROM complaints WHERE id = ?",
      args: [id],
    });
    res.json({ success: true, id });
  } catch (error: any) {
    console.error("Error deleting complaint:", error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: AI Intelligent Database Erase Evaluator
app.post("/api/admin/ai-eval-erase", async (req, res) => {
  const { prompt, documents } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "Erase prompt is required" });
  }

  if (!Array.isArray(documents) || documents.length === 0) {
    return res.json({ 
      matchingDocIds: [], 
      explanation: "There are no documents in the database to evaluate.",
      matchedDetails: [] 
    });
  }

  try {
    const systemInstruction = `You are an AI database curator and pruning agent for a food service knowledge base.
Your job is to strictly evaluate a list of database documents against the user's natural language erasure prompt, and determine exactly which document IDs should be deleted.

Guidelines:
1. Carefully inspect the user's prompt (e.g. "delete all burger items", "remove drinks and cocktails", "erase documents from last week", "delete everything", "remove refund policy").
2. Match documents based on their name, content, type, or timestamp.
3. If the user prompt asks to delete everything, clear all, or wipe database, return all document IDs.
4. Output MUST be valid JSON with this exact schema:
{
  "matchingDocIds": ["docId1", "docId2"],
  "explanation": "Clear human-readable summary of what was matched and why.",
  "matchedDetails": [
    {
      "id": "docId1",
      "name": "Document Name",
      "reason": "Why this document matches the erasure criteria"
    }
  ]
}`;

    const promptPayload = `USER ERASURE PROMPT:
"""
${prompt}
"""

CURRENT DATABASE DOCUMENTS (${documents.length} total):
${JSON.stringify(documents.map((d: any) => ({
  id: d.id,
  name: d.name,
  type: d.type,
  createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : "Unknown",
  contentSnippet: (d.content || "").slice(0, 800), // First 800 chars for semantic matching
})), null, 2)}

Respond with JSON only.`;

    const responseText = await runLLMGeneration({
      system: systemInstruction,
      prompt: promptPayload,
    }) || "{}";
    let parsedResult: any = {};
    try {
      parsedResult = JSON.parse(responseText);
    } catch {
      parsedResult = {
        matchingDocIds: [],
        explanation: responseText,
        matchedDetails: []
      };
    }

    res.json(parsedResult);
  } catch (error: any) {
    console.error("AI Erase Evaluation error:", error);
    res.status(500).json({ error: error.message || "Failed to evaluate AI erase prompt" });
  }
});

// Handle unmatched API routes to ensure JSON responses (prevents HTML fallback)
app.use("/api", (req, res, next) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` });
});

// API Error Handler Middleware
app.use("/api", (err: any, req: any, res: any, next: any) => {
  console.error("API Error Middleware caught:", err?.message || err);
  res.status(err?.status || 500).json({ error: err?.message || "Internal server error" });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;

if (process.env.VERCEL !== "1") {
  startServer();
}
