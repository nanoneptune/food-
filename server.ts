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

// Robust JSON Extractor & Parser (handles markdown wraps & conversational commentary)
function cleanAndParseJson(text: string): any {
  if (!text) return null;
  let raw = text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(raw);
  } catch {}
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

// 100% Groq Exclusively for LLM Generation (Groq Llama 3.3 70B & Llama 3.1 8B)
async function runLLMGeneration({
  system,
  prompt,
  messages,
}: {
  system?: string;
  prompt?: string;
  messages?: any[];
}): Promise<string> {
  const groqKey = (process.env.GROQ_API_KEY || "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").replace(/["'\r\n ]/g, "").trim();

  if (!groqKey || groqKey === "YOUR_GROQ_API_KEY") {
    console.error("[Groq Error] GROQ_API_KEY is not configured in environment");
    return "";
  }

  const groqModels = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
    "llama3-70b-8192",
    "llama3-8b-8192"
  ];

  let formattedMessages = messages && messages.length > 0
    ? messages.map((m: any) => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        content: typeof m.content === 'string' ? m.content : (typeof m.text === 'string' ? m.text : JSON.stringify(m.content || ''))
      }))
    : [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt || "" }
      ];

  if (system && messages && messages.length > 0 && formattedMessages[0]?.role !== "system") {
    formattedMessages = [{ role: "system", content: system }, ...formattedMessages];
  }

  for (const model of groqModels) {
    try {
      console.log(`[Groq Request] Querying Groq with model: ${model}...`);
      const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: formattedMessages,
          max_tokens: 800,
          temperature: 0.2,
        }),
      }, 9000);

      if (groqRes.ok) {
        const data: any = await groqRes.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (reply && reply.trim()) {
          console.log(`[Groq Success] Model ${model} responded (${reply.length} chars)`);
          return reply.trim();
        }
      } else {
        const errTxt = await groqRes.text().catch(() => '');
        console.warn(`Groq API returned status ${groqRes.status} for model ${model}:`, errTxt);
      }
    } catch (e: any) {
      console.warn(`Groq API attempt failed for ${model}:`, e?.message);
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

  // 1 for Kannada, 2 for Hindi, 3 for English
  gather.say({ voice: "Google.en-IN-Standard-A" as any }, "Welcome to VoxAssist.");
  gather.say({ voice: "Google.kn-IN-Standard-A" as any, language: "kn-IN" as any }, "ಕನ್ನಡಕ್ಕಾಗಿ ಒಂದನ್ನು ಒತ್ತಿ."); // Kannadakkagi ondanna otti
  gather.say({ voice: "Google.hi-IN-Wavenet-A" as any, language: "hi-IN" as any }, "हिंदी के लिए दो दबाएं।"); // Hindi ke liye 2 dabaye
  gather.say({ voice: "Google.en-IN-Standard-A" as any }, "For English, press 3.");

  twiml.say({ voice: "Google.en-IN-Standard-A" as any }, "No selection received. Please try calling again.");
  twiml.redirect("/api/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Handle Language Selection (DTMF Digit 1, 2, 3 or Speech Keyword)
app.all("/api/voice/menu-select", (req: any, res: any) => {
  const digits = (req.body.Digits || "").trim();
  const speech = (req.body.SpeechResult || "").toLowerCase();
  const twiml = new twilio.twiml.VoiceResponse();

  let selectedLang = "kn-IN"; // Default if 1
  let langName = "Kannada";
  let greetingText = "ನಮಸ್ಕಾರ! VoxAssist AI ಸಹಾಯಕ್ಕೆ ಸ್ವಾಗತ. ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಅಥವಾ ಸಮಸ್ಯೆಯನ್ನು ಹೇಳಿ.";
  let ttsVoice = "Google.kn-IN-Standard-A";

  if (digits === "1" || speech.includes("kannada") || speech.includes("ondanna")) {
    selectedLang = "kn-IN";
    langName = "Kannada";
    greetingText = "ನಮಸ್ಕಾರ! VoxAssist AI ಸಹಾಯಕ್ಕೆ ಸ್ವಾಗತ. ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಅಥವಾ ಸಮಸ್ಯೆಯನ್ನು ಹೇಳಿ.";
    ttsVoice = "Google.kn-IN-Standard-A";
  } else if (digits === "2" || speech.includes("hindi") || speech.includes("do")) {
    selectedLang = "hi-IN";
    langName = "Hindi";
    greetingText = "नमस्ते! VoxAssist AI सहायक में आपका स्वागत है। आप अपनी समस्या या प्रश्न बताएं।";
    ttsVoice = "Google.hi-IN-Wavenet-A";
  } else if (digits === "3" || speech.includes("english") || speech.includes("three")) {
    selectedLang = "en-US";
    langName = "English";
    greetingText = "Hello! Welcome to VoxAssist AI Support. How can I assist you today?";
    ttsVoice = "Polly.Joanna";
  } else {
    // Invalid key fallback
    const retryGather = twiml.gather({
      input: ["dtmf", "speech"],
      numDigits: 1,
      action: "/api/voice/menu-select",
      method: "POST",
      timeout: 6,
    });
    retryGather.say({ voice: "Google.en-IN-Standard-A" as any }, "Invalid selection.");
    retryGather.say({ voice: "Google.kn-IN-Standard-A" as any, language: "kn-IN" as any }, "ಕನ್ನಡಕ್ಕಾಗಿ ಒಂದನ್ನು ಒತ್ತಿ.");
    retryGather.say({ voice: "Google.hi-IN-Wavenet-A" as any, language: "hi-IN" as any }, "हिंदी के लिए दो दबाएं।");
    retryGather.say({ voice: "Google.en-IN-Standard-A" as any }, "For English, press 3.");
    twiml.redirect("/api/voice");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  // Prompt user for their actual question in the selected language
  const gather = twiml.gather({
    input: ["speech"],
    action: `/api/voice/respond?lang=${encodeURIComponent(selectedLang)}&langName=${encodeURIComponent(langName)}`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
    language: selectedLang as any,
  });

  gather.say({ voice: ttsVoice as any }, greetingText);

  twiml.say({ voice: ttsVoice as any }, "No speech detected. Please speak after the tone.");
  twiml.redirect("/api/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Twilio Voice IVR Conversation Loop in Selected Language
app.all("/api/voice/respond", async (req: any, res: any) => {
  const userSpeech = req.body.SpeechResult || req.body.UnstableSpeechResult || "";
  const selectedLang = req.query.lang || "hi-IN";
  const langName = req.query.langName || "Hindi";
  const twiml = new twilio.twiml.VoiceResponse();

  let ttsVoice = "Google.hi-IN-Wavenet-A";
  let noSpeechMessage = "क्षमा करें, मैं समझ नहीं पाया। कृपया दोबारा बोलें।";

  if (selectedLang === "kn-IN") {
    ttsVoice = "Google.kn-IN-Standard-A";
    noSpeechMessage = "ಕ್ಷಮಿಸಿ, ನಿಮ್ಮ ದ್ವನಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ಹೇಳಿ.";
  } else if (selectedLang === "en-US") {
    ttsVoice = "Polly.Joanna";
    noSpeechMessage = "Sorry, I didn't catch that. Please try speaking again.";
  }

  if (!userSpeech || !userSpeech.trim()) {
    const gather = twiml.gather({
      input: ["speech"],
      action: `/api/voice/respond?lang=${encodeURIComponent(selectedLang)}&langName=${encodeURIComponent(langName)}`,
      method: "POST",
      speechTimeout: "auto",
      timeout: 6,
      language: selectedLang as any,
    });
    gather.say({ voice: ttsVoice as any }, noSpeechMessage);
    twiml.redirect("/api/voice");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  try {
    const aiResponse = await runLLMGeneration({
      system: `You are VoxAssist, a helpful AI customer support agent answering phone calls. The caller selected ${langName}. You MUST respond exclusively in ${langName}. Keep spoken responses concise, empathetic, and natural (1 to 2 short sentences max).`,
      prompt: userSpeech,
    });

    let fallbackReply = "धन्यवाद! हम आपकी सहायता के लिए यहाँ हैं।";
    if (selectedLang === "kn-IN") {
      fallbackReply = "ಧನ್ಯವಾದಗಳು! ನಿಮ್ಮ ಸಹಾಯಕ್ಕಾಗಿ ನಾವು ಇಲ್ಲಿದ್ದೇವೆ.";
    } else if (selectedLang === "en-US") {
      fallbackReply = "Thank you! We are here to assist you.";
    }

    const replyText = aiResponse || fallbackReply;

    const gather = twiml.gather({
      input: ["speech"],
      action: `/api/voice/respond?lang=${encodeURIComponent(selectedLang)}&langName=${encodeURIComponent(langName)}`,
      method: "POST",
      speechTimeout: "auto",
      timeout: 6,
      language: selectedLang as any,
    });

    gather.say({ voice: ttsVoice as any }, replyText);

    // Prompt for further questions in selected language
    let followUp = "क्या आपको किसी और चीज़ में मदद चाहिए?";
    if (selectedLang === "kn-IN") {
      followUp = "ನಿಮಗೆ ಬೇರೆ ಯಾವುದೇ ಸಹಾಯ ಬೇಕೇ?";
    } else if (selectedLang === "en-US") {
      followUp = "Is there anything else I can help you with?";
    }

    twiml.say({ voice: ttsVoice as any }, followUp);
    twiml.redirect("/api/voice");
  } catch (err: any) {
    console.error("IVR processing error:", err?.message || err);
    twiml.say({ voice: ttsVoice as any }, "Technical issue encountered. Please try calling back later.");
    twiml.hangup();
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

// High-Fidelity Sarvam AI Text-to-Speech Engine
async function generateSarvamTTS(text: string, language: string): Promise<string | null> {
  const sarvamKey = (process.env.SARVAM_API_KEY || "").replace(/["'\r\n ]/g, "").trim();
  if (!sarvamKey) return null;

  try {
    let targetLangCode = "kn-IN";
    let speaker = "kavitha"; // Native Kannada female voice in bulbul:v3

    const langStr = String(language || '').toLowerCase();
    if (langStr.includes("hi")) {
      targetLangCode = "hi-IN";
      speaker = "priya"; // Native Hindi female voice in bulbul:v3
    } else if (langStr.includes("en")) {
      targetLangCode = "en-IN";
      speaker = "aditya"; // Native Indian English voice in bulbul:v3
    } else {
      targetLangCode = "kn-IN";
      speaker = "kavitha";
    }

    const clean = stripEmojis(text).slice(0, 500);
    if (!clean) return null;

    const res = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": sarvamKey,
      },
      body: JSON.stringify({
        inputs: [clean],
        target_language_code: targetLangCode,
        speaker: speaker,
        model: "bulbul:v3"
      }),
    });

    if (res.ok) {
      const data: any = await res.json();
      if (data && data.audios && data.audios[0]) {
        return `data:audio/wav;base64,${data.audios[0]}`;
      }
    }
  } catch (err: any) {
    console.warn("Sarvam TTS generation notice:", err?.message);
  }
  return null;
}

// Helper to generate TTS audio data URI for instant playback
async function generateTTSAudioUrl(text: string, language: string): Promise<string | null> {
  return await generateSarvamTTS(text, language);
}

// Entity cleaning helper
function cleanExtractedString(str: string): string {
  if (!str) return '';
  return str
    .replace(/^(ನಾನು|ನನ್ನ|ನನಗೆ|ನಾವು|ಅಲ್ಲಿ|ಇಲ್ಲಿ|ಹೇಳೋ|ಹೇಳ್ತೀನಿ|ಹೇಳಲು|ಹೋಗಿದ್ದು|ಬಂದಿದ್ದು|ನೋಡಿದ್ರೆ|ಆ|ಈ|ಅಂತ|ಎಂಬ|ಹೆಸರಿನ|ಹೆಸರು|ಸ್ಥಳ|ಹೋಟೆಲ್|ರೆಸ್ಟೋರೆಂಟ್)\s+/gi, '')
    .replace(/\s+(ಆಗಿದೆ|ಇದೆ|ಇತ್ತು|ಆಗಿತ್ತು|ಇರ್ಬೋದು|ಅನ್ನೋದು|ಅಂತ|ಎಂಬ|ಹೋಟೆಲ್|ನಲ್ಲಿ|ಗೆ)$/gi, '')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .trim();
}

interface ExtractedEntities {
  location?: string;
  when?: string;
  cause?: string;
  item?: string;
  owner?: string;
  isExhaustedOrConfirming: boolean;
  isInformationalInquiry: boolean;
  hasAllRequired: boolean;
  missingFields: string[];
  suggestedPrompt: string;
}

// Semantic Memory & Customer Word Analyzer for Context Awareness across turns
function analyzeCustomerWords(
  currentText: string,
  history: Array<{ role: string; text?: string; content?: string }> = [],
  existingData: any = {},
  language: string = 'kn-IN'
): ExtractedEntities {
  const allUserTexts = [
    ...history.filter(h => h.role === 'user').map(h => h.text || h.content || ''),
    currentText || ''
  ].join(' ');

  const isKannada = language.startsWith('kn') || language.toLowerCase().includes('kannada');
  const isHindi = language.startsWith('hi') || language.toLowerCase().includes('hindi');

  const entities: ExtractedEntities = {
    location: existingData.location || undefined,
    when: existingData.when || undefined,
    cause: existingData.cause || undefined,
    item: existingData.item || undefined,
    owner: existingData.owner || undefined,
    isExhaustedOrConfirming: false,
    isInformationalInquiry: false,
    hasAllRequired: false,
    missingFields: [],
    suggestedPrompt: ''
  };

  // 1. Check for customer exhaustion / confirmation
  const exhaustionRegex = /(ಅಷ್ಟೇ|ಇಷ್ಟೇ|ಎಷ್ಟೇ|ನನಗೆ.*ಗೊತ್ತಿಲ್ಲ|ಬೇರೇನೂ.*ಇಲ್ಲ|ಎಲ್ಲ.*ಹೇಳಿದೆ|ಮುಗಿಯಿತು|ದೂರು.*ದಾಖಲಿಸಿ|ದೃಢೀಕರಿಸಿ|ಸರಿ|ಹೌದು|ಅಷ್ಟೇ ಕಣ್ರಿ|ಇಷ್ಟೇ ಗೊತ್ತಿರೋದು|ಬಸ್ ಇಷ್ಟೇ|confirm|submit|yes|that is all|that's all|i told you|nothing more|proceed|all details given|itna hi|itna hi pata|ho gaya|darj karo|pusti)/i;
  if (exhaustionRegex.test(currentText)) {
    entities.isExhaustedOrConfirming = true;
  }

  // 2. Check for informational inquiries (FSSAI laws, hygiene rules, licenses, general questions)
  const infoRegex = /(fssai|license|licence|hygiene rule|inspection|penalty|fine|what is|how to|about|explain|details|information|ನಿಯಮ|ಪರವಾನಗಿ|ದಂಡ|ತನಿಖೆ|ನಿಯಮಾವಳಿ|ಪ್ರಮಾಣಪತ್ರ|ನಿಯಮಗಳು|ಲೈಸೆನ್ಸ್|ನಿಯಮಾವಳಿಗಳು|ತಿಳಿಸಿ|ಹೇಳಿ|ಏನು|ಹೇಗೆ|ಬಗ್ಗೆ|ಕಾನೂನು|ಯಾವ|कानून|नियम|लाइसेंस|जुर्माना|जांच प्रक्रिया|क्या है|बताइए|जानकारी)/i;
  const complaintSpecificKeywords = /(ಉಪ್ಪು\s*ಜಾಸ್ತಿ|ಹುಳು|ಹುಳ|ಕೂದಲು|ಹಾಳಾಗಿದೆ|ಹಳಸಿದ|ವಾಂತಿ|ಹೊಟ್ಟೆ\s*ನೋವು|ಕೊಳಕು|ಕೃತಕ\s*ಬಣ್ಣ|ಕಲ್ಮಶ|ವಿಷಾಹಾರ|ವಿಷಪೂರಿತ|ಕೀಡಾ|ಬದಬೂ|spoiled|poisoning|dirty|vomiting|insect|dead cockroach)/i;
  if (infoRegex.test(currentText) && !complaintSpecificKeywords.test(currentText)) {
    entities.isInformationalInquiry = true;
  }

  // 3. Location / Restaurant Name Extraction
  if (!entities.location) {
    const knHotelMatch = allUserTexts.match(/(?:ಹೋಟೆಲ್|ಹೊಟೆಲ್|ರೆಸ್ಟೋರೆಂಟ್|ಕ್ಯಾಂಟೀನ್|ಧಾಬಾ|ಬೇಕರಿ|ಶಾಪ್|ಶಾಪ್‌)\s+([^\s,.\n]+(?:\s+[^\s,.\n]+){0,2})|([^\s,.\n]+(?:\s+[^\s,.\n]+){0,2})\s+(?:ಹೋಟೆಲ್|ಹೊಟೆಲ್|ರೆಸ್ಟೋರೆಂಟ್|ಕ್ಯಾಂಟೀನ್|ಧಾಬಾ|ಬೇಕರಿ)/i);
    if (knHotelMatch) {
      const captured = cleanExtractedString(knHotelMatch[1] || knHotelMatch[2] || '');
      if (captured && captured.length > 2 && !/^(ಇದೆ|ಇತ್ತು|ಆಗಿದೆ|ನಾನು|ನೀವು)$/.test(captured)) {
        entities.location = `${captured} ಹೋಟೆಲ್`;
      }
    }
    if (!entities.location) {
      const knSpecific = allUserTexts.match(/(ಅನ್ನಪೂರ್ಣೇಶ್ವರಿ|ಅನ್ನಪೂರ್ಣ|ಉಡುಪಿ|ಶಾಂತಿ ಸಾಗರ್|ಕಾಮತ್|ಮಾಯೂರ|ನಂದಿನಿ|ನಂದಗೋಕುಲ|ಗುರು ಕೃಪಾ|ವೆಂಕಟೇಶ್ವರ|ಶ್ರೀ ಕೃಷ್ಣ|ಅಯೋಧ್ಯ|ಹಳ್ಳಿ ಮನೆ)/i);
      if (knSpecific) {
        entities.location = `${knSpecific[1]} ಹೋಟೆಲ್`;
      }
    }
    if (!entities.location) {
      const hiHotelMatch = allUserTexts.match(/(?:होटल|रेस्टोरेंट|ढाबा|दुकान|कैंटीन)\s+([^\s,.\n]+(?:\s+[^\s,.\n]+){0,2})|([^\s,.\n]+(?:\s+[^\s,.\n]+){0,2})\s+(?:होटल|रेस्टोरेंट|ढाबा|दुकान)/i);
      if (hiHotelMatch) {
        const captured = cleanExtractedString(hiHotelMatch[1] || hiHotelMatch[2] || '');
        if (captured && captured.length > 2) entities.location = `${captured} होटल`;
      }
    }
    if (!entities.location) {
      const enHotelMatch = allUserTexts.match(/(?:at|in|from|hotel|restaurant|cafe|dhaba)\s+([A-Z][a-zA-Z0-9\s'-]{2,25}(?:Hotel|Restaurant|Cafe|Dhaba|Kitchen|Bhavan|Sagar)?)/i);
      if (enHotelMatch && enHotelMatch[1]) {
        const captured = enHotelMatch[1].trim();
        if (!/^(the|yesterday|today|night|evening|morning|food|dinner)$/i.test(captured)) {
          entities.location = captured;
        }
      }
    }
  }

  // 4. Incident Timing (When) Extraction
  if (!entities.when) {
    const knTimeMatch = allUserTexts.match(/(ನಿನ್ನೆ\s*(?:ರಾತ್ರಿ|ಸಂಜೆ|ಬೆಳಗ್ಗೆ|ಮಧ್ಯಾಹ್ನ)?|ಇಂದು\s*(?:ರಾತ್ರಿ|ಸಂಜೆ|ಬೆಳಗ್ಗೆ|ಮಧ್ಯಾಹ್ನ)?|ಮೊನ್ನೆ|ಈಗಲೇ|ಬೆಳಗ್ಗೆ\s*\d*(?::\d*)?|ಸಂಜೆ\s*\d*(?::\d*)?|ರಾತ್ರಿ\s*\d*(?::\d*)?|\d{1,2}[:.]\d{2}\s*(?:ಗಂಟೆಗೆ|pm|am)?|\d{1,2}\s*(?:ತಾರೀಖು|ದಿನಾಂಕ|ದಿನದ ಹಿಂದೆ))/i);
    if (knTimeMatch) {
      entities.when = knTimeMatch[0].trim();
    }
    if (!entities.when) {
      const hiTimeMatch = allUserTexts.match(/(कल\s*(?:रात|शाम|सुबह|दोपहर)?|आज\s*(?:रात|शाम|सुबह|दोपहर)?|परसों|शाम को|रात को|सुबह को|\d{1,2}[:.]\d{2}\s*(?:बजे|pm|am)?)/i);
      if (hiTimeMatch) {
        entities.when = hiTimeMatch[0].trim();
      }
    }
    if (!entities.when) {
      const enTimeMatch = allUserTexts.match(/(yesterday(?:\s*(?:night|evening|morning|afternoon))?|today(?:\s*(?:night|evening|morning|afternoon))?|last night|\d{1,2}[:.]\d{2}\s*(?:am|pm)?|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i);
      if (enTimeMatch) {
        entities.when = enTimeMatch[0].trim();
      }
    }
  }

  // 5. Cause & Violation Extraction
  if (!entities.cause) {
    const knCauseMatch = allUserTexts.match(/(ಉಪ್ಪು\s*ಜಾಸ್ತಿ|ಸೋಡಿಯಂ|ಕಲುಷಿತ|ವಾಸನೆ|ಹುಳು|ಹುಳ|ಕೂದಲು|ಹಾಳಾಗಿದೆ|ಹಳಸಿದ|ವಾಂತಿ|ಹೊಟ್ಟೆ\s*ನೋವು|ಕೊಳಕು|ಕೃತಕ\s*ಬಣ್ಣ|ಕಲ್ಮಶ|ಪ್ಲಾಸ್ಟಿಕ್|ಅಜೀರ್ಣ|ಬೇಧಿ|ಆಸ್ಪತ್ರೆ|ವಿಷಾಹಾರ|ವಿಷಪೂರಿತ|ಕೆಟ್ಟ\s*ರುಚಿ)/i);
    if (knCauseMatch) {
      entities.cause = knCauseMatch[0].trim();
    }
    const hiCauseMatch = allUserTexts.match(/(नमक\s*ज्यादा|सोडियम|बासी|कीड़ा|बाल|दुर्गंध|बदबू|उल्टी|पेट\s*दर्द|गंदा|नकली\s*रंग|विषाक्त|फूड\s*पॉइजनिंग|खराब|सड़ा)/i);
    if (!entities.cause && hiCauseMatch) {
      entities.cause = hiCauseMatch[0].trim();
    }
    const enCauseMatch = allUserTexts.match(/(excess(?:\s+of)?\s*(?:salt|sodium)|food poisoning|stomach (?:ache|pain)|vomiting|dead (?:insect|cockroach|fly)|hair in food|foul smell|spoiled|contaminated|stale|dirty|unhygienic|rotten)/i);
    if (!entities.cause && enCauseMatch) {
      entities.cause = enCauseMatch[0].trim();
    }
  }

  // 6. Food Item Name Extraction
  if (!entities.item) {
    const itemMatch = allUserTexts.match(/(ದೋಸೆ|ಇಡ್ಲಿ|ಬಿರಿಯಾನಿ|ಅನ್ನ|ಸಾಂಬಾರ್|ಪಲ್ಯ|ಪರೋಟ|ರೊಟ್ಟಿ|ಚಪಾತಿ|ಊಟ|ಚಿಕನ್|ಮಟನ್|ಮೀನು|ರಸಂ|ಮಜ್ಜಿಗೆ|ನೀರು|ಚಹಾ|ಕಾಫಿ|ದೋಸಾ|इडली|डोसा|बिरयानी|चावल|सांभर|रोटी|सब्जी|दाल|पानी|biryani|dosa|idli|rice|meals|curry|sambar|paneer|chicken|mutton|roti)/i);
    if (itemMatch) {
      entities.item = itemMatch[0].trim();
    }
  }

  // 7. Owner Name Extraction
  if (!entities.owner) {
    const ownerMatch = allUserTexts.match(/(?:ಮಾಲೀಕರು|ಮಾಲೀಕ|ಓನರ್|ಹೆಸರು|owner|malik)\s+([^\s,.\n]+)/i);
    if (ownerMatch) {
      entities.owner = cleanExtractedString(ownerMatch[1]);
    }
  }

  // 8. Missing Fields computation
  if (!entities.location) entities.missingFields.push('location');
  if (!entities.when) entities.missingFields.push('when');
  if (!entities.cause) entities.missingFields.push('cause');

  entities.hasAllRequired = entities.missingFields.length === 0;

  // 9. Formulate an intelligent prompt in selected language
  if (entities.hasAllRequired || entities.isExhaustedOrConfirming) {
    if (isKannada) {
      entities.suggestedPrompt = "ತುಂಬು ಹೃದಯದ ಧನ್ಯವಾದಗಳು. ತಮ್ಮ ದೂರನ್ನು ಸಿದ್ಧಪಡಿಸಲಾಗಿದೆ. ತಾವು ಸ್ವತಃ ಧ್ವನಿ ಸಂದೇಶ ರೆಕಾರ್ಡ್ ಮಾಡಲು ಬಯಸಿದರೆ 7 ಒತ್ತಿ, ಅಥವಾ ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ.";
    } else if (isHindi) {
      entities.suggestedPrompt = "धन्यवाद। हमने विवरण नोट कर लिया है। यदि आप ऑडियो संदेश रिकॉर्ड करना चाहते हैं तो 7 दबाएँ, अथवा शिकायत दर्ज करने के लिए 9 दबाएँ।";
    } else {
      entities.suggestedPrompt = "Thank you. We have recorded your complaint. If you would like to record a voice note, press 7. To submit your complaint now, press 9 or say confirm.";
    }
  } else {
    if (entities.missingFields.includes('location')) {
      if (isKannada) {
        entities.suggestedPrompt = "ದಯವಿಟ್ಟು ಈ ಘಟನೆ ನಡೆದ ಹೋಟೆಲ್, ರೆಸ್ಟೋರೆಂಟ್ ಅಥವಾ ಅಂಗಡಿಯ ಹೆಸರನ್ನು ಸವಿನಯವಾಗಿ ತಿಳಿಸುವಿರಾ?";
      } else if (isHindi) {
        entities.suggestedPrompt = "कृपया उस होटल, रेस्टोरेंट या दुकान का नाम बताएं जहाँ यह घटना हुई।";
      } else {
        entities.suggestedPrompt = "Could you please tell us the name of the hotel, restaurant, or outlet where this incident occurred?";
      }
    } else if (entities.missingFields.includes('when')) {
      const locAck = entities.location ? `${entities.location} ನಮೂದಿಸಲಾಗಿದೆ. ` : '';
      const locAckHi = entities.location ? `${entities.location} नोट कर लिया गया है। ` : '';
      const locAckEn = entities.location ? `Noted ${entities.location}. ` : '';
      if (isKannada) {
        entities.suggestedPrompt = `${locAck}ದಯವಿಟ್ಟು ಈ ಘಟನೆ ಯಾವ ದಿನ ಅಥವಾ ಯಾವ ಸಮಯದಲ್ಲಿ ನಡೆಯಿತು ಎಂದು ತಿಳಿಸುವಿರಾ?`;
      } else if (isHindi) {
        entities.suggestedPrompt = `${locAckHi}कृपया बताएं कि यह घटना किस तारीख या किस समय हुई थी?`;
      } else {
        entities.suggestedPrompt = `${locAckEn}Could you please mention the date or approximate time of this incident?`;
      }
    } else if (entities.missingFields.includes('cause')) {
      const locAck = entities.location ? `${entities.location} ನಮೂದಿಸಲಾಗಿದೆ. ` : '';
      const locAckHi = entities.location ? `${entities.location} नोट कर लिया गया है। ` : '';
      const locAckEn = entities.location ? `Noted ${entities.location}. ` : '';
      if (isKannada) {
        entities.suggestedPrompt = `${locAck}ಆಹಾರದಲ್ಲಿ ತಾವು ಎದುರಿಸಿದ ನಿಖರವಾದ ಲೋಪ ಅಥವಾ ನೈರ್ಮಲ್ಯ ಸಮಸ್ಯೆಯನ್ನು ತಿಳಿಸುವಿರಾ?`;
      } else if (isHindi) {
        entities.suggestedPrompt = `${locAckHi}कृपया भोजन में आई खराबी या स्वच्छता संबंधी समस्या का विवरण बताएं।`;
      } else {
        entities.suggestedPrompt = `${locAckEn}Could you please describe what was wrong with the food or hygiene?`;
      }
    }
  }

  return entities;
}

// API: Chat with Assistant (Grounding on recognized knowledge base & zero-delay QA cache)
app.post("/api/chat", async (req, res) => {
  const { message, context, language, profile, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required" });
  }

  const queryText = message.trim();
  const targetLang = language || "English";

  // Semantic Memory & Customer Words Analysis across turns
  const analysis = analyzeCustomerWords(queryText, history, {}, targetLang);

  // 1. Check Turso DB qa_cache for pre-computed FAQ answers ONLY if this is not a specific incident/complaint
  const isIncidentReport = /(incident|complaint|hotel|food|restaurant|ದೂರು|ಹೋಟೆಲ್|ಆಹಾರ|ಉಪ್ಪು|ಹುಳು|ವಾಂತಿ|ಹೊಟ್ಟೆ|ಅನ್ನಪೂರ್ಣೇಶ್ವರಿ|ವಾಸನೆ|ಕೊಳಕು|ಹಾಳಾಗಿದೆ|ನೋವು|ಆಸ್ಪತ್ರೆ|ಬೇಧಿ|ದಯವಿಟ್ಟು|ಮಧ್ಯಾಹ್ನ|ರಾತ್ರಿ|ಸಂಜೆ|ಬೆಳಗ್ಗೆ|ನಿನ್ನೆ|ಇಂದು|ಬಿರಿಯಾನಿ|ದೋಸೆ|ಇಡ್ಲಿ|ಅನ್ನ|ಸಾಂಬಾರ್|शिकायत|होटल|खाना|नमक|कीड़ा|उल्टी|बासी|सड़ा|दुकान|रेस्टोरेंट)/i.test(queryText);
  if (!isIncidentReport && !analysis.location && !analysis.cause) {
    try {
      const turso = getTurso();
      if (turso) {
        const cacheRes = await turso.execute({
          sql: "SELECT * FROM qa_cache WHERE language = ? ORDER BY created_at DESC LIMIT 40",
          args: [targetLang]
        });

        if (cacheRes && cacheRes.rows && cacheRes.rows.length > 0) {
          const rows = cacheRes.rows as any[];
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
              response: matchedRow.answer,
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
  }

  try {
    let effectiveContext = context || "";

    if (!effectiveContext.trim()) {
      try {
        const turso = getTurso();
        const kbResult = await turso.execute("SELECT name, content FROM knowledge_base ORDER BY createdAt DESC");
        effectiveContext = kbResult.rows.map(r => `--- ${r.name} ---\n${r.content}`).join("\n\n");
      } catch (dbErr: any) {
        console.warn("Could not load knowledge from Turso in /api/chat:", dbErr?.message);
      }
    }

    const isInfoOrGeneral = analysis.isInformationalInquiry || /^(what|how|why|who|explain|tell|fssai|rules|law|information|hello|hi|help|ಏನು|ಹೇಗೆ|ಯಾಕೆ|ಯಾರು|ತಿಳಿಸಿ|ಹೇಳಿ|ಬಗ್ಗೆ|ನಮಸ್ಕಾರ|ಸಹಾಯ|क्या|कैसे|बताओ|जानकारी|नमस्ते)/i.test(queryText);

    const systemPrompt = `You are VoxAssist's expert AI Food Safety, Hygiene, and Standards Inspection Authority Assistant.
You represent the Official Government Food Safety & Hygiene Consumer Grievance Portal.
You are powered directly by Groq AI. Always generate complete, accurate, high-quality responses.

Citizen Profile:
- Name: ${profile?.name || "Citizen"}
- Phone: ${profile?.phone || "Not provided"}
- Location: ${profile?.location || "Not specified"}

KNOWLEDGE BASE & REGULATORY DIRECTIVES:
"""
${effectiveContext || "Standard FSSAI Food Safety & Standards Guidelines apply."}
"""

TARGET RESPONSE LANGUAGE: ${targetLang}.
CRITICAL LANGUAGE MANDATE:
Every single word of your response MUST strictly be in ${targetLang}.
If Kannada, write purely in Kannada script (ಕನ್ನಡ ಲಿಪಿ). If Hindi, write purely in Devanagari script (हिंदी). If English, write in English. Do NOT mix languages!

CONVERSATION CONTEXT & CLASSIFICATION:
- Informational / Educational / General Inquiry: ${isInfoOrGeneral ? "YES" : "NO"}
- Location Extracted: ${analysis.location || "None"}
- Timing Extracted: ${analysis.when || "None"}
- Cause Extracted: ${analysis.cause || "None"}
- Customer Exhaustion / Ready to Submit: ${analysis.isExhaustedOrConfirming ? "YES" : "NO"}

CRITICAL RESPONSE RULES:
1. INFORMATIONAL / GENERAL QUESTIONS (E.g. FSSAI, rules, standards, licenses, testing, general inquiries):
   - Answer the question directly, thoroughly, and intelligently with statutory knowledge in ${targetLang}.
   - DO NOT ask for incident details (e.g. do NOT ask "where did this incident happen?" or "which hotel?") unless the user is explicitly trying to report a specific spoiled food grievance.
   - Be helpful, polite, and authoritative.

2. COMPLAINT & GRIEVANCE REPORTING (Only when user reports spoiled food, restaurant violations, illness, contamination):
   - If location, when, and cause are known OR user says that is all they know:
     Generate the official Food Safety Grievance Report markdown format below and end with COMPLAINT_DRAFT_REQUEST.
   - If details are missing, politely ask ONLY for the missing detail.

MARKDOWN GRIEVANCE REPORT FORMAT (FOR COMPLAINTS ONLY):
# 📋 Official Food Safety & Inspection Grievance Report
> **Reference ID:** #FS-${Date.now().toString().slice(-6)} | **Authority:** Food Safety Inspection Division | **Priority:** Urgent | **Status:** Logged for Enforcement

---

### 📍 Incident & Inspection Summary
| Parameter | Details |
| :--- | :--- |
| **Complainant Name** | ${profile?.name || "Valued Citizen"} |
| **Contact Phone** | ${profile?.phone || "Registered Phone"} |
| **Establishment / Location (WHERE)** | ${analysis.location || "[Extracted Location/Branch]"} |
| **Incident Date & Time (WHEN)** | ${analysis.when || "[Extracted Date/Time]"} |
| **Target Food Product** | ${analysis.item || "Reported Food Item"} |
| **Violation / Contamination (CAUSE)** | ${analysis.cause || "[Extracted Cause/Violation]"} |
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
      ? history.slice(-8).map((h: any) => ({
          role: (h.role === "assistant" || h.sender === "assistant") ? "assistant" : "user",
          content: String(h.content || h.text || "")
        }))
      : [];

    const fullMessages = [
      ...conversationHistory,
      { role: "user", content: queryText }
    ];

    let responseText = await runLLMGeneration({
      system: systemPrompt,
      messages: fullMessages,
    });

    // Intelligent context-aware fallback if LLM returned empty or repetitive response
    if (!responseText || responseText.trim().length < 5) {
      if (isInfoOrGeneral) {
        if (targetLang === 'Kannada') {
          responseText = `FSSAI (ಭಾರತೀಯ ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಪ್ರಾಧಿಕಾರ - Food Safety and Standards Authority of India) ಭಾರತದಲ್ಲಿ ಆಹಾರದ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟವನ್ನು ನಿಯಂತ್ರಿಸುವ ಶಾಸನಬದ್ಧ ಪ್ರಾಧಿಕಾರವಾಗಿದೆ.\n\nಇದು ಆಹಾರ ತಯಾರಕರು, ಹೋಟೆಲ್‌ಗಳು ಮತ್ತು ವ್ಯಾಪಾರಿಗಳಿಗೆ ಕಡ್ಡಾಯ ಆಹಾರ ಪರವಾನಗಿ (FSSAI License) ಮತ್ತು ನೈರ್ಮಲ್ಯ ಮಾರ್ಗಸೂಚಿಗಳನ್ನು ಜಾರಿಗೊಳಿಸುತ್ತದೆ. ಯಾವುದೇ ಕಲಬೆರಕೆ ಅಥವಾ ಕಲುಷಿತ ಆಹಾರದ ವಿರುದ್ಧ ನಾಗರಿಕರು ಅಧಿಕೃತವಾಗಿ ದೂರು ಸಲ್ಲಿಸಬಹುದು.`;
        } else if (targetLang === 'Hindi') {
          responseText = `FSSAI (भारतीय खाद्य सुरक्षा और मानक प्राधिकरण - Food Safety and Standards Authority of India) भारत में खाद्य उत्पादों की गुणवत्ता और सुरक्षा को नियंत्रित करने वाला वैधानिक प्राधिकरण है।\n\nयह सभी खाद्य विक्रेताओं, होटलों और निर्माताओं के लिए स्वच्छता दिशानिर्देश और खाद्य लाइसेंस अनिवार्य करता है। उपभोक्ता किसी भी मिलावट या अस्वच्छ भोजन के खिलाफ शिकायत दर्ज कर सकते हैं।`;
        } else {
          responseText = `FSSAI (Food Safety and Standards Authority of India) is the apex statutory authority established under the Ministry of Health & Family Welfare to lay down science-based standards for food and regulate their manufacture, storage, distribution, and sale to ensure wholesome and safe food for human consumption.`;
        }
      } else if (analysis.hasAllRequired || analysis.isExhaustedOrConfirming) {
        const refId = `#FS-${Date.now().toString().slice(-6)}`;
        const loc = analysis.location || "ಹೋಟೆಲ್ / ಆಹಾರ ಮಳಿಗೆ";
        const tim = analysis.when || "ಇತ್ತೀಚೆಗೆ";
        const cau = analysis.cause || "ಆಹಾರ ನೈರ್ಮಲ್ಯ ಹಾಗೂ ಗುಣಮಟ್ಟದ ಲೋಪ";
        const itm = analysis.item || "ಆಹಾರ ಪದಾರ್ಥ";

        if (targetLang === 'Kannada') {
          responseText = `ತುಂಬು ಹೃದಯದ ಧನ್ಯವಾದಗಳು ${profile?.name || ''}. ತಮ್ಮ ಆಹಾರ ಸುರಕ್ಷತಾ ದೂರನ್ನು ಅಧಿಕೃತವಾಗಿ ಸ್ವೀಕರಿಸಲಾಗಿದೆ. ನಾವು ಸಂಬಂಧಪಟ್ಟ ಆಹಾರ ಸುರಕ್ಷತಾ ಅಧಿಕಾರಿಗೆ (FSO) ತಕ್ಷಣದ ಸ್ಥಳ ಪರಿಶೀಲನೆಗೆ ರವಾನಿಸುತ್ತೇವೆ.\n\n# 📋 Official Food Safety & Inspection Grievance Report\n> **Reference ID:** ${refId} | **Authority:** ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ಗುಣಮಟ್ಟ ಇಲಾಖೆ | **Priority:** ತುರ್ತು | **Status:** ತನಿಖೆಗೆ ದಾಖಲಾಗಿದೆ\n\n---\n\n### 📍 Incident & Inspection Summary\n| ವಿವರ | ದಾಖಲೆ |\n| :--- | :--- |\n| **ದೂರುದಾರರ ಹೆಸರು** | ${profile?.name || "ಗೌರವಾನ್ವಿತ ನಾಗರಿಕರು"} |\n| **ಸಂಪರ್ಕ ಸಂಖ್ಯೆ** | ${profile?.phone || "ದಾಖಲಿತ ದೂರವಾಣಿ"} |\n| **ಸ್ಥಳ / ಸಂಸ್ಥೆ (WHERE)** | ${loc} |\n| **ದಿನಾಂಕ ಮತ್ತು ಸಮಯ (WHEN)** | ${tim} |\n| **ಆಹಾರ ಪದಾರ್ಥ** | ${itm} |\n| **ದೂರಿನ ಕಾರಣ (CAUSE)** | ${cau} |\n| **ದಾಖಲಾದ ಸಮಯ** | ${new Date().toLocaleString('kn-IN')} |\n\n---\n\n### 🔍 ತನಿಖಾ ನಿರ್ದೇಶನ\n1. ಆಹಾರ ಸುರಕ್ಷತಾ ಅಧಿಕಾರಿಗಳಿಂದ (FSO) ಸ್ಥಳ ಪರಿಶೀಲನೆ.\n2. ಆಹಾರ ಮಾದರಿಗಳ ಜಪ್ತಿ ಮತ್ತು ಪ್ರಯೋಗಾಲಯ ಪರೀಕ್ಷೆ.\n3. ಲೋಪ ಎಸಗಿದ ಸಂಸ್ಥೆಗೆ ಕಾರಣ ಕೇಳಿ ನೋಟಿಸ್ ಜಾರಿ.\n\nCOMPLAINT_DRAFT_REQUEST`;
        } else if (targetLang === 'Hindi') {
          responseText = `धन्यवाद ${profile?.name || ''}। आपकी खाद्य सुरक्षा शिकायत आधिकारिक रूप से दर्ज कर ली गई है। हम खाद्य सुरक्षा अधिकारी (FSO) को तुरंत निरीक्षण के लिए भेज रहे हैं।\n\n# 📋 Official Food Safety & Inspection Grievance Report\n> **Reference ID:** ${refId} | **Authority:** खाद्य सुरक्षा एवं मानक प्रभाग | **Priority:** अति आवश्यक | **Status:** जांच हेतु दर्ज\n\n---\n\n### 📍 Incident & Inspection Summary\n| विवरण | रिकॉर्ड |\n| :--- | :--- |\n| **शिकायतकर्ता का नाम** | ${profile?.name || "सम्मानित नागरिक"} |\n| **संपर्क फोन** | ${profile?.phone || "पंजीकृत फोन"} |\n| **स्थान / होटल (WHERE)** | ${loc} |\n| **घटना की तिथि/समय (WHEN)** | ${tim} |\n| **खाद्य सामग्री** | ${itm} |\n| **समस्या का कारण (CAUSE)** | ${cau} |\n| **दर्ज समय** | ${new Date().toLocaleString('hi-IN')} |\n\nCOMPLAINT_DRAFT_REQUEST`;
        } else {
          responseText = `Thank you ${profile?.name || ''}. Your food safety complaint has been formally registered. A Food Safety Officer (FSO) will conduct an inspection.\n\n# 📋 Official Food Safety & Inspection Grievance Report\n> **Reference ID:** ${refId} | **Authority:** Food Safety Inspection Division | **Priority:** Urgent | **Status:** Logged for Enforcement\n\n---\n\n### 📍 Incident & Inspection Summary\n| Parameter | Details |\n| :--- | :--- |\n| **Complainant Name** | ${profile?.name || "Valued Citizen"} |\n| **Contact Phone** | ${profile?.phone || "Registered Phone"} |\n| **Establishment / Location (WHERE)** | ${loc} |\n| **Incident Date & Time (WHEN)** | ${tim} |\n| **Target Food Product** | ${itm} |\n| **Violation / Contamination (CAUSE)** | ${cau} |\n| **Logged Timestamp** | ${new Date().toLocaleString()} |\n\nCOMPLAINT_DRAFT_REQUEST`;
        }
      } else {
        responseText = analysis.suggestedPrompt || "ನಮಸ್ಕಾರ, ನಾವು ತಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು? (How can we assist you today?)";
      }
    }

    const isComplaintDraft = responseText.includes("COMPLAINT_DRAFT_REQUEST");
    const cleanedText = responseText.replace(/COMPLAINT_DRAFT_REQUEST/g, "").trim();

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
        if (language === 'Kannada') {
          spokenPart = `ನಾವು ಮುಂದಿನ ಕ್ರಮವನ್ನು ಕೈಗೊಳ್ಳುತ್ತೇವೆ. ಧನ್ಯವಾದಗಳು${customerName}! ಬೈ${customerName}, ತಮ್ಮ ದಿನ ಶುಭವಾಗಿರಲಿ!`;
        } else if (language === 'Hindi') {
          spokenPart = `हम आगे की उचित कार्रवाई करेंगे। धन्यवाद${customerName}! बाय${customerName}, आपका दिन शुभ हो!`;
        } else {
          spokenPart = `We will take care further. Thank you${customerName}! Bye${customerName}, have a nice day!`;
        }
      }
    }

    // Generate audio for fast playback & Cloudinary storage using spoken portion
    const audioUrl = await generateTTSAudioUrl(spokenPart.slice(0, 450), targetLang);

    // Save newly generated Q&A pair into Turso DB qa_cache
    try {
      const turso = getTurso();
      if (turso && cleanedText && !isComplaintDraft) {
        const newId = `qa_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        turso.execute({
          sql: `INSERT INTO qa_cache (id, normalized_intent, language, question, answer, audio_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [newId, "general_query", targetLang, queryText, cleanedText, audioUrl || "", Date.now()]
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
      cached: false 
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

  let currentLang = collectedData?.language || language || "en-IN";
  let nextStep = step;
  let replyText = "";
  let updatedData = { ...collectedData };
  if (audioNoteUrl) {
    updatedData.audioNoteUrl = audioNoteUrl;
  }
  let isComplaintReady = false;
  let markdownReport = "";

  // Explicit Script-based and DTMF language detection
  if (digits === "1" || (step === "welcome" && (/1|one|kannada|ಕನ್ನಡ|ಒಂದು/i.test(message || "")))) {
    currentLang = "kn-IN";
  } else if (digits === "2" || (step === "welcome" && (/2|two|hindi|हिंदी|हिन्दी|दो|ಎರಡು/i.test(message || "")))) {
    currentLang = "hi-IN";
  } else if (digits === "3" || (step === "welcome" && (/3|three|english|ಇಂಗ್ಲಿಷ್|ಮೂರು|तीन/i.test(message || "")))) {
    currentLang = "en-IN";
  } else if (message && /[\u0C80-\u0CFF]/.test(message)) {
    currentLang = "kn-IN";
  } else if (message && /[\u0900-\u097F]/.test(message)) {
    currentLang = "hi-IN";
  }

  updatedData.language = currentLang;

  const isKannada = currentLang === "kn-IN" || currentLang === "Kannada";
  const isHindi = currentLang === "hi-IN" || currentLang === "Hindi";
  const langName = isKannada ? "Kannada (ಕನ್ನಡ)" : (isHindi ? "Hindi (हिंदी)" : "English");

  try {
    // 1. DTMF Language Selection (1 = Kannada, 2 = Hindi, 3 = English)
    if (digits === "1" || (step === "welcome" && (/1|one|kannada|ಕನ್ನಡ|ಒಂದು/i.test(message || "")))) {
      currentLang = "kn-IN";
      updatedData.language = "kn-IN";
      nextStep = "collecting_info";
      replyText = "ನಮಸ್ಕಾರ! ಆಹಾರ ಸುರಕ್ಷತಾ ಪರಿಶೀಲನೆ ಸಹಾಯವಾಣಿಗೆ ಸ್ವಾಗತ. ದಯವಿಟ್ಟು ತಾವು ಎದುರಿಸಿದ ಆಹಾರ ನೈರ್ಮಲ್ಯ ಅಥವಾ ಕಲುಷಿತ ಆಹಾರದ ದೂರಿನ ಬಗ್ಗೆ ವಿವರವಾಗಿ ತಿಳಿಸಿ. ನಾವು ಸೂಕ್ತ ತನಿಖೆ ನಡೆಸುತ್ತೇವೆ.";
    } else if (digits === "2" || (step === "welcome" && (/2|two|hindi|हिंदी|हिन्दी|दो|ಎರಡು/i.test(message || "")))) {
      currentLang = "hi-IN";
      updatedData.language = "hi-IN";
      nextStep = "collecting_info";
      replyText = "नमस्ते! खाद्य सुरक्षा एवं निरीक्षण हेल्पलाइन में आपका स्वागत है। कृपया अपनी खाद्य सुरक्षा या स्वच्छता संबंधी शिकायत का विवरण बताएं। हम उचित जांच करेंगे।";
    } else if (digits === "3" || (step === "welcome" && (/3|three|english|ಇಂಗ್ಲಿಷ್|ಮೂರು|तीन/i.test(message || "")))) {
      currentLang = "en-IN";
      updatedData.language = "en-IN";
      nextStep = "collecting_info";
      replyText = "Welcome to the Food Safety & Standards Inspection Authority Helpline. Please describe the food safety, contamination, or hygiene issue you encountered. We will investigate immediately.";
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
        const prompt = `The customer just recorded an audio voice note describing their food complaint.
Voice note transcript: "${message}"
Caller Selected Language: ${langName} (${currentLang})
Known details:
- Cause: ${updatedData.cause || "Unknown"}
- Location: ${updatedData.location || "Unknown"}
- When: ${updatedData.when || "Unknown"}
- Item: ${updatedData.item || "Unknown"}

Instructions:
1. Extract any newly mentioned cause (what went wrong/details), location/where (restaurant name, branch, address), when (date or time), or food item name.
2. Acknowledge what the caller spoke in their voice note in 1-2 calm, reassuring sentences.
3. Then state clearly: "To submit your complaint now, press 9 or say confirm." (in ${langName}).
4. CRITICAL: The response MUST be strictly in ${langName}. If Kannada, use polite Kannada honorifics (ನಮಸ್ಕಾರ, ಧನ್ಯವಾದಗಳು, ತಾವು, ತಮ್ಮ). If Hindi, use polite Hindi (नमस्ते, धन्यवाद, आप).

Respond in strict JSON:
{
  "cause": "updated or existing cause",
  "location": "updated or existing location",
  "when": "updated or existing when",
  "item": "updated or existing item",
  "spokenResponse": "1-2 highly polite sentences to speak to caller strictly in ${langName}"
}`;

        try {
          const aiResponse = await runLLMGeneration({ prompt }) || "{}";
          const parsed = JSON.parse(aiResponse);
          if (parsed.cause) updatedData.cause = parsed.cause;
          if (parsed.location) updatedData.location = parsed.location;
          if (parsed.when) updatedData.when = parsed.when;
          if (parsed.item) updatedData.item = parsed.item;
          if (parsed.spokenResponse) replyText = parsed.spokenResponse;
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
      // Analyze customer words with semantic context memory
      const analysis = analyzeCustomerWords(message, history, updatedData, currentLang);
      if (analysis.location && !updatedData.location) updatedData.location = analysis.location;
      if (analysis.when && !updatedData.when) updatedData.when = analysis.when;
      if (analysis.cause && !updatedData.cause) updatedData.cause = analysis.cause;
      if (analysis.item && !updatedData.item) updatedData.item = analysis.item;
      if (analysis.owner && !updatedData.owner) updatedData.owner = analysis.owner;

      const prompt = `You are a calm, gentle, highly empathetic, and polite IVR Phone Agent for VoxAssist Consumer Food Safety Helpline.
User profile: Name: ${profile?.name || "Caller"}, Phone: ${profile?.phone || "On File"}, Location: ${profile?.location || "Not given"}.
Currently known details from memory:
- Cause: ${updatedData.cause || "Unknown"}
- Location/Where: ${updatedData.location || "Unknown"}
- When: ${updatedData.when || "Unknown"}
- Item: ${updatedData.item || "Unknown"}
- Missing Required Fields: ${analysis.missingFields.join(", ") || "None"}
- Customer Exhaustion / Done Talking: ${analysis.isExhaustedOrConfirming ? "YES" : "NO"}

Customer just said: "${message}"

Selected Language: ${langName} (${currentLang}).

CRITICAL MANDATORY INSTRUCTIONS:
1. You MUST generate the spokenResponse 100% in ${langName}. If the language is Kannada (${isKannada ? 'YES' : 'NO'}), EVERY SINGLE WORD must be in Kannada script. If Hindi (${isHindi ? 'YES' : 'NO'}), EVERY SINGLE WORD must be in Hindi script. NEVER use English words for Kannada/Hindi callers.
2. DO NOT ask for any details that are already known in memory!
3. If any of the following details are missing, calmly and politely ask the customer for ONLY ONE missing detail:
   - WHERE (the specific restaurant, branch, or outlet name)
   - WHEN (the date and approximate time of the incident)
   - CAUSE / DETAILS (what was wrong with the food or service)
4. When speaking Kannada, ALWAYS use polite and respectful honorifics (ನಮಸ್ಕಾರ, ದಯವಿಟ್ಟು, ತಾವು, ತಮ್ಮ, ಸವಿನಯವಾಗಿ, ತಿಳಿಸಿಕೊಡಿ, ಕ್ಷಮಿಸಿ).
5. When speaking Hindi, ALWAYS use polite honorifics (नमस्ते, कृपया, आप, आपका, धन्यवाद).
6. If Cause, Location, and When are known OR if Customer Exhaustion is YES:
   Calmly summarize and state:
   ${isKannada 
     ? '"ಧನ್ಯವಾದಗಳು, ವಿವರಗಳನ್ನು ದಾಖಲಿಸಲಾಗಿದೆ. ತಾವು ಧ್ವನಿ ಸಂದೇಶ ರೆಕಾರ್ಡ್ ಮಾಡಲು ಬಯಸಿದರೆ 7 ಒತ್ತಿ, ಅಥವಾ ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ."' 
     : (isHindi 
        ? '"धन्यवाद, विवरण दर्ज कर लिया गया है। यदि आप ऑडियो संदेश रिकॉर्ड करना चाहते हैं तो 7 दबाएँ, अथवा शिकायत दर्ज करने के लिए 9 दबाएँ।"' 
        : '"Thank you, details are recorded. If you would like to record a voice note, press 7. To submit your complaint now, press 9 or say confirm."')}
7. Keep your spoken response to 1-2 calm, highly polite, reassuring sentences strictly in ${langName}.

Respond in strict JSON:
{
  "cause": "updated or existing cause",
  "location": "updated or existing location",
  "when": "updated or existing when",
  "item": "updated or existing item",
  "spokenResponse": "1-2 highly polite sentences to speak to the caller strictly in ${langName}",
  "hasRequiredDetails": true/false
}`;

      const aiResponse = await runLLMGeneration({ prompt }) || "{}";
      const parsed: any = cleanAndParseJson(aiResponse) || {};

      if (parsed.cause && !updatedData.cause) updatedData.cause = parsed.cause;
      if (parsed.location && !updatedData.location) updatedData.location = parsed.location;
      if (parsed.when && !updatedData.when) updatedData.when = parsed.when;
      if (parsed.item && !updatedData.item) updatedData.item = parsed.item;

      const hasAllDetails = parsed.hasRequiredDetails || 
        analysis.hasAllRequired || 
        analysis.isExhaustedOrConfirming || 
        (updatedData.cause && updatedData.location);

      if (hasAllDetails) {
        nextStep = "press_7_prompt";
        if (parsed.spokenResponse && (
          (isKannada && /[\u0C80-\u0CFF]/.test(parsed.spokenResponse)) ||
          (isHindi && /[\u0900-\u097F]/.test(parsed.spokenResponse)) ||
          (!isKannada && !isHindi)
        )) {
          replyText = parsed.spokenResponse;
        } else {
          replyText = analysis.suggestedPrompt || (
            isKannada
              ? `ತುಂಬು ಹೃದಯದ ಧನ್ಯವಾದಗಳು. ತಮ್ಮ ದೂರನ್ನು ಸಿದ್ಧಪಡಿಸಲಾಗಿದೆ. ತಾವು ಸ್ವತಃ ಧ್ವನಿ ಸಂದೇಶ ರೆಕಾರ್ಡ್ ಮಾಡಲು ಬಯಸಿದರೆ 7 ಒತ್ತಿ, ಅಥವಾ ದೂರನ್ನು ಸಲ್ಲಿಸಲು 9 ಒತ್ತಿ.`
              : (isHindi 
                  ? `धन्यवाद। हमने विवरण नोट कर लिया है। यदि आप अपनी आवाज़ में संदेश रिकॉर्ड करना चाहते हैं तो 7 दबाएँ, अथवा शिकायत दर्ज करने के लिए 9 दबाएँ।`
                  : `Thank you. We have recorded your concern. If you would like to record a voice note, press 7. To submit your complaint, press 9 or say confirm.`)
          );
        }
      } else {
        nextStep = "collecting_info";
        if (parsed.spokenResponse && (
          (isKannada && /[\u0C80-\u0CFF]/.test(parsed.spokenResponse)) ||
          (isHindi && /[\u0900-\u097F]/.test(parsed.spokenResponse)) ||
          (!isKannada && !isHindi)
        )) {
          replyText = parsed.spokenResponse;
        } else {
          replyText = analysis.suggestedPrompt;
        }
      }
    }

    // Generate high-fidelity TTS audio via Sarvam AI
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

// API: Sarvam AI Text-to-Speech (TTS)
app.post("/api/tts", async (req, res) => {
  try {
    const { text, language = "kn-IN" } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }
    const audioUrl = await generateSarvamTTS(text, language);
    if (audioUrl) {
      return res.json({ audioUrl });
    }
    return res.status(503).json({ error: "Sarvam AI TTS not available" });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "TTS failed" });
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
    const groqKey = process.env.GROQ_API_KEY || "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";

    if (groqKey && groqKey !== "YOUR_GROQ_API_KEY") {
      try {
        const formData = new FormData();
        const audioBuffer = req.file.buffer;
        const mime = req.file.mimetype || "audio/webm";

        const fileObj = typeof File !== "undefined"
          ? new File([audioBuffer], "voice.webm", { type: mime })
          : new Blob([audioBuffer], { type: mime });

        formData.append("file", fileObj as any, "voice.webm");
        formData.append("model", "whisper-large-v3-turbo");

        if (language === "Hindi" || language === "hi-IN") {
          formData.append("language", "hi");
        } else if (language === "Kannada" || language === "kn-IN") {
          formData.append("language", "kn");
        } else {
          formData.append("language", "en");
        }

        const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqKey}`,
          },
          body: formData,
        });

        const contentType = groqRes.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const groqData: any = await groqRes.json();
          const text = groqData?.text?.trim();

          if (text && !isHallucinatedTranscript(text)) {
            console.log(`[STT Success] Groq Whisper transcribed (${language || 'en'}): "${text}"`);
            return res.json({ transcript: text, provider: "groq-whisper" });
          }
        }
      } catch (groqWhisperErr: any) {
        console.warn("Groq Whisper STT failed:", groqWhisperErr?.message);
      }
    }

    res.status(200).json({ transcript: "", error: "Could not transcribe audio using Groq." });
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
