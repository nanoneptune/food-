import express, { Request } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@libsql/client";
import * as pdf from "pdf-parse";
import Tesseract from "tesseract.js";
import { createOpenAI } from "@ai-sdk/openai";
import { createGroq } from "@ai-sdk/groq";
import { generateText } from "ai";
import twilio from "twilio";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { PassThrough } from "stream";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Helper to convert WebM buffer to WAV buffer for strict APIs (like Sarvam)
async function convertWebmToWav(buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputStream = new PassThrough();
    inputStream.end(buffer);
    
    const outputStream = new PassThrough();
    const chunks: Buffer[] = [];
    
    outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    outputStream.on("error", reject);
    
    ffmpeg(inputStream)
      .toFormat("wav")
      .on("error", reject)
      .pipe(outputStream);
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

// Universal Fast & Resilient LLM Invocation Helper (Gemini + Groq + OpenAI)
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

  // 1. Primary Option: Google Gemini API (GEMINI_API_KEY / GOOGLE_GENAI_API_KEY / API_KEY)
  const geminiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GENAI_API_KEY,
    process.env.API_KEY,
  ].filter(Boolean) as string[];

  for (const geminiKey of geminiKeys) {
    if (!geminiKey || geminiKey === "YOUR_GEMINI_API_KEY") continue;
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      
      const contents = formattedMessages.map((m: any) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: typeof m.content === "string" ? m.content : (typeof m.content === "object" ? JSON.stringify(m.content) : String(m.content)) }]
      }));

      const res = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents,
        ...(system ? { config: { systemInstruction: system } } : {}),
      });

      if (res.text && res.text.trim()) {
        return res.text.trim();
      }
    } catch (gErr: any) {
      console.warn("Gemini SDK call notice, trying REST endpoint:", gErr?.message);
      try {
        const restUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
        const restRes = await fetchWithTimeout(restUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: system ? { parts: [{ text: system }] } : undefined,
            contents: formattedMessages.map((m: any) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }]
            }))
          })
        }, 8000);
        if (restRes.ok) {
          const restData: any = await restRes.json();
          const text = restData?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text && text.trim()) return text.trim();
        }
      } catch (restErr: any) {
        console.warn("Gemini REST endpoint notice:", restErr?.message);
      }
    }
  }

  // 2. Second Priority: Active Groq Fast LLMs (Ultra-low latency)
  const groqKeys = [
    process.env.GROQ_API_KEY,
    "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"
  ].filter(Boolean) as string[];

  const activeGroqModels = [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "llama3-70b-8192"
  ];

  for (const gKey of groqKeys) {
    if (!gKey || gKey === "YOUR_GROQ_API_KEY") continue;
    for (const gModel of activeGroqModels) {
      try {
        const groqRes = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${gKey}`,
          },
          body: JSON.stringify({
            model: gModel,
            messages: formattedMessages,
            temperature: 0.5,
            max_tokens: 600,
          }),
        }, 8000);

        if (groqRes.ok) {
          const data: any = await groqRes.json();
          const reply = data?.choices?.[0]?.message?.content;
          if (reply && reply.trim()) {
            return reply.trim();
          }
        }
      } catch (err: any) {
        // Try next
      }
    }
  }

  // 3. Third Priority: Vercel AI Gateway (openai/gpt-4o-mini / gpt-4o)
  const vercelKeys = [
    process.env.OPENAI_API_KEY,
    "vck_3GaBkIjy2p0dPWns5uvuO7an1KdbnY1bAeIT6WHAXoYSXORqJF1rhJMo"
  ].filter(Boolean) as string[];

  const vercelModels = [
    "openai/gpt-4o-mini",
    "openai/gpt-4o"
  ];

  for (const vKey of vercelKeys) {
    if (!vKey || vKey === "YOUR_OPENAI_API_KEY") continue;
    for (const vModel of vercelModels) {
      try {
        const gatewayRes = await fetchWithTimeout("https://ai-gateway.vercel.sh/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${vKey}`,
          },
          body: JSON.stringify({
            model: vModel,
            messages: formattedMessages,
            max_tokens: 600,
          }),
        }, 10000);

        if (gatewayRes.ok) {
          const data: any = await gatewayRes.json();
          const reply = data?.choices?.[0]?.message?.content;
          if (reply && reply.trim()) {
            return reply.trim();
          }
        }
      } catch (e: any) {
        // Try next
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
  gather.say({ voice: "Google.en-IN-Standard-A" }, "Welcome to VoxAssist.");
  gather.say({ voice: "Google.kn-IN-Standard-A", language: "kn-IN" }, "ಕನ್ನಡಕ್ಕಾಗಿ ಒಂದನ್ನು ಒತ್ತಿ."); // Kannadakkagi ondanna otti
  gather.say({ voice: "Google.hi-IN-Wavenet-A", language: "hi-IN" }, "हिंदी के लिए दो दबाएं।"); // Hindi ke liye 2 dabaye
  gather.say({ voice: "Google.en-IN-Standard-A" }, "For English, press 3.");

  twiml.say({ voice: "Google.en-IN-Standard-A" }, "No selection received. Please try calling again.");
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
    retryGather.say({ voice: "Google.en-IN-Standard-A" }, "Invalid selection.");
    retryGather.say({ voice: "Google.kn-IN-Standard-A", language: "kn-IN" }, "ಕನ್ನಡಕ್ಕಾಗಿ ಒಂದನ್ನು ಒತ್ತಿ.");
    retryGather.say({ voice: "Google.hi-IN-Wavenet-A", language: "hi-IN" }, "हिंदी के लिए दो दबाएं।");
    retryGather.say({ voice: "Google.en-IN-Standard-A" }, "For English, press 3.");
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
    language: selectedLang,
  });

  gather.say({ voice: ttsVoice }, greetingText);

  twiml.say({ voice: ttsVoice }, "No speech detected. Please speak after the tone.");
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
      language: selectedLang,
    });
    gather.say({ voice: ttsVoice }, noSpeechMessage);
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
      language: selectedLang,
    });

    gather.say({ voice: ttsVoice }, replyText);

    // Prompt for further questions in selected language
    let followUp = "क्या आपको किसी और चीज़ में मदद चाहिए?";
    if (selectedLang === "kn-IN") {
      followUp = "ನಿಮಗೆ ಬೇರೆ ಯಾವುದೇ ಸಹಾಯ ಬೇಕೇ?";
    } else if (selectedLang === "en-US") {
      followUp = "Is there anything else I can help you with?";
    }

    twiml.say({ voice: ttsVoice }, followUp);
    twiml.redirect("/api/voice");
  } catch (err: any) {
    console.error("IVR processing error:", err?.message || err);
    twiml.say({ voice: ttsVoice }, "Technical issue encountered. Please try calling back later.");
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

// API: Upload to Cloudinary
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
        const pdfParser = (pdf as any).default || pdf;
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

// API: Chat with Assistant (Grounding on recognized knowledge base)
app.post("/api/chat", async (req, res) => {
  const { message, context, language, profile, history } = req.body;

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

    const systemPrompt = `You are an expert AI Food Service and Customer Support Voice Assistant for VoxAssist.
Customer Profile:
- Name: ${profile?.name || "Guest"}
- Phone: ${profile?.phone || "Not provided"}
- Location: ${profile?.location || "Not specified"}

KNOWLEDGE BASE CONTEXT (Menus, policies, items, pricing, rules recognized from admin documents):
"""
${effectiveContext || "No custom knowledge documents uploaded yet."}
"""

TARGET RESPONSE LANGUAGE: ${language || "English"}.

INSTRUCTIONS & BEHAVIOR:
1. Ground your answers directly on the provided Knowledge Base Context. If the customer asks about dishes, ingredients, prices, timings, allergens, or procedures present in the knowledge base, provide accurate, helpful answers.
2. If the user reports an issue, spoiled food, delay, incorrect order, hygiene concern, or complaint:
   - Sympathize warmly and offer to register an official report/complaint with their audio.
   - You MUST append the token "COMPLAINT_DRAFT_REQUEST" at the very end of your response so the system opens the complaint confirmation dialog.
3. If the user is confirming a complaint (saying yes, confirm, okay, ha, sari), acknowledge that it has been logged and escalated to the management.
4. Keep spoken responses concise, natural, and clear (1-3 sentences), ideal for voice synthesis.
5. Always speak in the requested language (${language || "English"}).
6. Maintain memory of the conversation flow. Refer back to previous questions or topics when asked follow-up questions (e.g., "why?", "tell me more", "how much").`;

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
        responseText = "ನಮಸ್ಕಾರ! ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಸ್ವೀಕರಿಸಲಾಗಿದೆ. ನಮ್ಮ ಆಹಾರ ಪದಾರ್ಥಗಳು ಮತ್ತು ಸೇವೆಗಳ ಬಗ್ಗೆ ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?";
      } else if (language === 'Hindi') {
        responseText = "नमस्ते! आपका संदेश प्राप्त हुआ। मैं हमारे भोजन मेनू और सेवाओं के बारे में आपकी कैसे सहायता कर सकता हूँ?";
      } else {
        responseText = "Hello! I have received your request. How may I assist you with our food menu and services today?";
      }
    }

    const isComplaintDraft = responseText.includes("COMPLAINT_DRAFT_REQUEST");
    const cleanedText = responseText.replace("COMPLAINT_DRAFT_REQUEST", "").trim();

    res.json({ response: cleanedText, isComplaintDraft });
  } catch (error: any) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message || "Failed to process chat" });
  }
});

// API: Sarvam AI Text-to-Speech (TTS)
app.post("/api/tts", async (req, res) => {
  const { text, language } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });

  const sarvamKey = process.env.SARVAM_API_KEY || "sk_0l4vlm3x_DFA9ROZg56RLZl9Y83gkHKfW";
  
  let targetLang = "en-IN";
  let speaker = "ritu";
  if (language === "Hindi" || language === "hi-IN") {
    targetLang = "hi-IN";
    speaker = "ritu";
  } else if (language === "Kannada" || language === "kn-IN") {
    targetLang = "kn-IN";
    speaker = "ritu";
  }

  try {
    const cleanedText = text.replace(/[*#_`~\[\]\(\)]/g, '').replace(/https?:\/\/\S+/g, '').trim();
    const response = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": sarvamKey,
      },
      body: JSON.stringify({
        inputs: [cleanedText.slice(0, 500)],
        target_language_code: targetLang,
        speaker: speaker,
        model: "bulbul:v3"
      })
    });

    if (!response.ok) {
      console.warn(`Sarvam TTS status ${response.status}: defaulting to browser Speech Synthesis`);
      return res.status(response.status).json({ error: "Sarvam TTS service unavailable, defaulting to browser Speech Synthesis" });
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data: any = await response.json();
      if (data && data.audios && data.audios.length > 0) {
        return res.json({ audioBase64: data.audios[0], audioFormat: "wav" });
      }
    }
    res.status(400).json({ error: "Failed to generate TTS from Sarvam" });
  } catch (err: any) {
    console.warn("Sarvam TTS notice:", err?.message || err);
    res.status(500).json({ error: err.message || "TTS error" });
  }
});

// Helper to detect Whisper hallucinations on silent/quiet audio clips
function isHallucinatedTranscript(text: string): boolean {
  if (!text || !text.trim()) return true;
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
    "noise"
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
    const sarvamKey = process.env.SARVAM_API_KEY || "sk_0l4vlm3x_DFA9ROZg56RLZl9Y83gkHKfW";
    const groqKey = process.env.GROQ_API_KEY || "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";

    let targetLang = "unknown";
    if (language === "Hindi" || language === "hi-IN") targetLang = "hi-IN";
    else if (language === "Kannada" || language === "kn-IN") targetLang = "kn-IN";
    else if (language === "English" || language === "en-IN") targetLang = "en-IN";

    // 1. Try Sarvam AI Saaras STT
    if (sarvamKey && sarvamKey !== "YOUR_SARVAM_API_KEY") {
      try {
        const formData = new FormData();
        const rawAudioBuffer = req.file.buffer;
        
        let wavBuffer: Buffer;
        let useRaw = false;
        try {
          wavBuffer = await convertWebmToWav(rawAudioBuffer);
        } catch (convErr) {
          console.warn("FFmpeg conversion skipped/failed, trying raw buffer directly:", convErr);
          wavBuffer = rawAudioBuffer;
          useRaw = true;
        }

        const originalMime = req.file.mimetype || "audio/webm";
        let ext = "wav";
        let mime = "audio/wav";
        
        if (useRaw) {
          mime = originalMime;
          if (originalMime.includes("mp4") || originalMime.includes("m4a")) ext = "mp4";
          else if (originalMime.includes("ogg")) ext = "ogg";
          else if (originalMime.includes("mpeg") || originalMime.includes("mp3")) ext = "mp3";
          else ext = "webm";
        }
        
        const fileObj = typeof File !== "undefined"
          ? new File([wavBuffer], `voice.${ext}`, { type: mime })
          : new Blob([wavBuffer], { type: mime });
          
        formData.append("file", fileObj as any, `voice.${ext}`);
        if (targetLang !== "unknown") {
          formData.append("language_code", targetLang);
        }
        formData.append("model", "saaras:v4");

        const response = await fetch("https://api.sarvam.ai/speech-to-text", {
          method: "POST",
          headers: {
            "api-subscription-key": sarvamKey,
          },
          body: formData,
        });

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data: any = await response.json();
          const text = data?.transcript?.trim();
          if (text && !isHallucinatedTranscript(text)) {
            return res.json({ transcript: text, provider: "sarvam" });
          }
        }
      } catch (sarvamErr: any) {
        console.warn("Sarvam STT failed, attempting Groq Whisper:", sarvamErr?.message);
      }
    }

    // 2. Try Groq Whisper STT (whisper-large-v3-turbo)
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
        if (language === "Hindi") formData.append("language", "hi");
        else if (language === "Kannada") formData.append("language", "kn");
        else if (language === "English") formData.append("language", "en");

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
            return res.json({ transcript: text, provider: "groq-whisper" });
          }
        }
      } catch (groqWhisperErr: any) {
        console.warn("Groq Whisper STT failed:", groqWhisperErr?.message);
      }
    }

    res.status(200).json({ transcript: "", error: "Could not transcribe audio from speech providers." });
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
