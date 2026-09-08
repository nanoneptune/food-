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

// Helper to generate & upload TTS audio to Cloudinary for instant playback
async function generateTTSAudioUrl(text: string, language: string): Promise<string | null> {
  // Groq does not have a TTS endpoint. We return null, the client will rely on browser synthesis.
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

  // 1. Check Turso DB qa_cache for pre-computed / cached intent answers
  try {
    const turso = getTurso();
    if (turso) {
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

TARGET RESPONSE LANGUAGE: ${language || "English"}.

STRICT CONVERSATION & RESPONSE RULES:
1. INFORMATIONAL QUESTIONS:
   - If the citizen asks a question about food safety regulations, FSSAI licensing, hygiene inspection rules, adulteration testing, food safety laws, or penalties, answer directly, precisely, and accurately with statutory guidance in the requested language (${language || "English"}).
   - Always use polite, respectful honorifics in Kannada (ನಮಸ್ಕಾರ, ದಯವಿಟ್ಟು, ತಾವು, ತಮ್ಮ, ಸವಿನಯವಾಗಿ).

2. COMPLAINT & GRIEVANCE REPORTING FLOW:
   - When the citizen reports a specific food safety violation, unhygienic restaurant/vendor, spoiled/contaminated food, food poisoning incident, or foreign object (insects, hair, glass, chemical odor):
     a) Express high empathy and serious concern for consumer health.
     b) Note down the incident details: WHERE (outlet/vendor/location), WHEN (date & time), and CAUSES/VIOLATIONS (symptoms, items, contamination details).
     c) If key details are missing, ask for them politely one by one.
     d) Once details are clear, generate the official Food Safety Grievance Report using the Markdown structure below, and append COMPLAINT_DRAFT_REQUEST at the end.

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
      ? history.slice(-8).map((h: any) => ({
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
      if (language === 'Kannada') {
        responseText = "ನಮಸ್ಕಾರ! ಇದು ಆಹಾರ ಸುರಕ್ಷತೆ ಮತ್ತು ನೈರ್ಮಲ್ಯ ಪರಿಶೀಲನೆ ಸಹಾಯವಾಣಿ. ಇಂದು ನಿಮ್ಮ ಆಹಾರ ಸುರಕ್ಷತಾ ದೂರಿಗೆ ನಾನು ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?";
      } else if (language === 'Hindi') {
        responseText = "नमस्ते! यह खाद्य सुरक्षा एवं स्वच्छता निरीक्षण हेल्पलाइन है। आज आपकी खाद्य सुरक्षा या शिकायत दर्ज करने में मैं कैसे सहायता कर सकता हूँ?";
      } else {
        responseText = "Greetings! This is the Food Safety & Inspection Authority Helpline. How may I assist you with your food safety or hygiene grievance today?";
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

  try {
    // 1. DTMF Language Selection (1 = Kannada, 2 = Hindi, 3 = English)
    if (digits === "1" || (step === "welcome" && (/1|one|kannada|ಕನ್ನಡ|ಒಂದು/i.test(message || "")))) {
      currentLang = "kn-IN";
      nextStep = "collecting_info";
      replyText = "ನಮಸ್ಕಾರ! ಆಹಾರ ಸುರಕ್ಷತಾ ಪರಿಶೀಲನೆ ಸಹಾಯವಾಣಿಗೆ ಸ್ವಾಗತ. ದಯವಿಟ್ಟು ತಾವು ಎದುರಿಸಿದ ಆಹಾರ ನೈರ್ಮಲ್ಯ ಅಥವಾ ಕಲುಷಿತ ಆಹಾರದ ದೂರಿನ ಬಗ್ಗೆ ವಿವರವಾಗಿ ತಿಳಿಸಿ. ನಾವು ಸೂಕ್ತ ತನಿಖೆ ನಡೆಸುತ್ತೇವೆ.";
    } else if (digits === "2" || (step === "welcome" && (/2|two|hindi|हिंदी|हिन्दी|दो|ಎರಡು/i.test(message || "")))) {
      currentLang = "hi-IN";
      nextStep = "collecting_info";
      replyText = "नमस्ते! खाद्य सुरक्षा एवं निरीक्षण हेल्पलाइन में आपका स्वागत है। कृपया अपनी खाद्य सुरक्षा या स्वच्छता संबंधी शिकायत का विवरण बताएं। हम उचित जांच करेंगे।";
    } else if (digits === "3" || (step === "welcome" && (/3|three|english|ಇಂಗ್ಲಿಷ್|ಮೂರು|तीन/i.test(message || "")))) {
      currentLang = "en-IN";
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
        const prompt = `The customer just recorded a voice note describing their food complaint.
Voice note transcript: "${message}"
Language: ${currentLang}
Known details:
- Cause: ${updatedData.cause || "Unknown"}
- Location: ${updatedData.location || "Unknown"}
- When: ${updatedData.when || "Unknown"}
- Item: ${updatedData.item || "Unknown"}

Instructions:
1. Extract any newly mentioned cause (what went wrong/details), location/where (restaurant name, branch, address), when (date or time), or food item name.
2. Acknowledge what the caller spoke in their voice note in 1-2 calm, reassuring sentences.
3. Then state clearly: "To submit your complaint now, press 9 or say confirm." (in ${currentLang}).
4. Use polite Kannada/Hindi honorifics.

Respond in strict JSON:
{
  "cause": "updated or existing cause",
  "location": "updated or existing location",
  "when": "updated or existing when",
  "item": "updated or existing item",
  "spokenResponse": "1-2 highly polite sentences to speak to caller in ${currentLang}"
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
      // Use LLM to extract cause, location, and when calmly
      const prompt = `You are a calm, gentle, highly empathetic, and polite IVR Phone Agent for VoxAssist Consumer Helpline.
User profile: Name: ${profile?.name || "Caller"}, Phone: ${profile?.phone || "On File"}, Location: ${profile?.location || "Not given"}.
Currently known details:
- Cause: ${updatedData.cause || "Unknown"}
- Location/Where: ${updatedData.location || "Unknown"}
- When: ${updatedData.when || "Unknown"}
- Item: ${updatedData.item || "Unknown"}

Customer just said: "${message}"

Language: ${currentLang} (kn-IN for Kannada, hi-IN for Hindi, en-IN for English).

Instructions:
1. Identify any newly mentioned cause (what went wrong/details), location/where (restaurant name, branch, address), when (date or time), or food item name.
2. If any of the following details are missing, calmly and politely ask the customer for them (one question at a time, with absolute politeness):
   - WHERE (the specific restaurant, branch, or outlet name)
   - WHEN (the date and approximate time of the incident)
   - CAUSE / DETAILS (what was wrong with the food or service)
3. When speaking Kannada, ALWAYS use polite and respectful honorifics (ನಮಸ್ಕಾರ, ದಯವಿಟ್ಟು, ತಾವು, ತಮ್ಮ, ಸವಿನಯವಾಗಿ, ತಿಳಿಸಿಕೊಡಿ, ಕ್ಷಮಿಸಿ).
4. If ALL THREE (Cause, Location/Where, and When) are now known:
   Calmly summarize the collected details and state:
   "If you would like to record a voice note, press 7. To submit your complaint now, press 9 or say confirm." (in the target language!).
5. Keep your spoken response to 1-2 calm, highly polite, reassuring sentences.

Respond in strict JSON:
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
        parsed = JSON.parse(aiResponse);
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
          replyText = parsed.spokenResponse;
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
        replyText = parsed.spokenResponse || (
          isKannada 
            ? "ದಯವಿಟ್ಟು ಈ ಘಟನೆ ನಡೆದ ಸ್ಥಳ, ಹೋಟೆಲ್ ಅಥವಾ ಅಂಗಡಿಯ ಹೆಸರನ್ನು ಸವಿನಯವಾಗಿ ತಿಳಿಸುವಿರಾ?" 
            : (isHindi ? "कृपया उस स्थान या रेस्टोरेंट का नाम बताएं जहाँ यह समस्या हुई।" : "Could you please let us know the location or restaurant name?")
        );
      }
    }

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

// API: Sarvam AI Text-to-Speech (TTS)
app.post("/api/tts", async (req, res) => {
  // Groq does not currently support TTS. 
  // We return a 501 Not Implemented so the frontend gracefully falls back to browser SpeechSynthesis.
  res.status(501).json({ error: "Groq TTS not available. Defaulting to browser Speech Synthesis." });
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
