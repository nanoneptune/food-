import express, { Request } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@libsql/client";
import * as pdf from "pdf-parse";
import { GoogleGenAI } from "@google/genai";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { generateText } from "ai";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Lazy initialization for Gemini AI SDK
let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return geminiClient;
}

// Turso Setup
let tursoClient: any = null;

function getTurso() {
  if (!tursoClient) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error("TURSO_DATABASE_URL environment variable is required");
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
      // First attempt full multimodal recognition using Gemini 3.7 Flash native PDF understanding
      try {
        const ai = getGeminiClient();
        const response = await ai.models.generateContent({
          model: "gemini-3.7-flash",
          contents: [
            {
              inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: "application/pdf",
              },
            },
            {
              text: `Perform comprehensive, accurate text extraction and OCR on this entire PDF document.
Extract all headings, paragraphs, food menus, dish items, prices, ingredients, policies, FAQs, contact info, rules, and table data.
Format the output cleanly in readable Markdown with clear sections. Do not summarize or truncate any text. Include every detail.`,
            },
          ],
        });
        content = response.text || "";
      } catch (geminiErr: any) {
        console.warn("Gemini PDF extraction encountered issue, falling back to pdf-parse:", geminiErr?.message);
        // Fallback to pdf-parse
        const pdfParser = (pdf as any).default || pdf;
        const data = await pdfParser(req.file.buffer);
        content = data.text || "";
      }

      // If content is still empty, try pdf-parse as secondary
      if (!content.trim()) {
        try {
          const pdfParser = (pdf as any).default || pdf;
          const data = await pdfParser(req.file.buffer);
          content = data.text || "";
        } catch (e) {
          console.warn("pdf-parse fallback also failed", e);
        }
      }
    } else if (fileType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(originalName)) {
      // Multimodal Vision OCR with Gemini 3.7 Flash
      const ai = getGeminiClient();
      const detectedMime = fileType.startsWith("image/") ? fileType : "image/jpeg";
      const response = await ai.models.generateContent({
        model: "gemini-3.7-flash",
        contents: [
          {
            inlineData: {
              data: req.file.buffer.toString("base64"),
              mimeType: detectedMime,
            },
          },
          {
            text: `Exhaustively extract and transcribe all text from this image or document.
Extract every single line of text, menu items, prices, dish descriptions, ingredients, contact numbers, notices, opening hours, hygiene standards, refund policies, and any fine print.
Format the output into clean, structured Markdown with headings and bullet points so it acts as complete knowledge base context. Do not omit any words or numbers.`,
          },
        ],
      });
      content = response.text || "";
    } else if (fileType === "text/plain" || fileType === "text/markdown" || fileType === "text/csv" || /\.(txt|md|csv|json)$/i.test(originalName)) {
      content = req.file.buffer.toString("utf-8");
    } else {
      // Attempt Gemini generic multimodal ingestion
      try {
        const ai = getGeminiClient();
        const response = await ai.models.generateContent({
          model: "gemini-3.7-flash",
          contents: [
            {
              inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: fileType,
              },
            },
            {
              text: "Extract all available text, information, and knowledge from this file.",
            },
          ],
        });
        content = response.text || "";
      } catch (fallbackErr) {
        content = req.file.buffer.toString("utf-8");
      }
    }

    if (!content.trim()) {
      return res.status(400).json({ error: "Could not extract readable text from the uploaded file." });
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
  const { message, context, language, profile } = req.body;

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
5. Always speak in the requested language (${language || "English"}).`;

    let responseText = "";

    // 1. Try Gemini 3.7 Flash if valid key
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && geminiKey !== "MY_GEMINI_API_KEY" && geminiKey.trim().length > 10) {
      try {
        const ai = getGeminiClient();
        const result = await ai.models.generateContent({
          model: "gemini-3.7-flash",
          contents: [{ text: message }],
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.4,
          },
        });
        responseText = result.text || "";
      } catch (geminiErr: any) {
        console.warn("Gemini generation skipped or failed:", geminiErr?.message);
      }
    }

    // 2. Fallback to Groq (Fast Llama-3.3-70B inference)
    if (!responseText) {
      const groqKey = process.env.GROQ_API_KEY || "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";
      if (groqKey && groqKey !== "YOUR_GROQ_API_KEY") {
        try {
          const { text } = await generateText({
            model: groq("llama-3.3-70b-versatile"),
            system: systemPrompt,
            prompt: message,
          });
          responseText = text;
        } catch (groqErr: any) {
          console.warn("Groq generation failed, attempting OpenAI / fallback:", groqErr?.message);
        }
      }
    }

    // 3. Fallback to OpenAI if configured
    if (!responseText && process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "YOUR_OPENAI_API_KEY") {
      try {
        const { text } = await generateText({
          model: openai("gpt-4o-mini"),
          system: systemPrompt,
          prompt: message,
        });
        responseText = text;
      } catch (openAiErr: any) {
        console.warn("OpenAI generation failed:", openAiErr?.message);
      }
    }

    // 4. Guaranteed natural fallback response
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

  const sarvamKey = process.env.SARVAM_API_KEY || "sk_8fboduyu_lLPqcpjGwCmBBBKaMF7JwsW5";
  
  let targetLang = "en-IN";
  let speaker = "meera";
  if (language === "Hindi" || language === "hi-IN") {
    targetLang = "hi-IN";
    speaker = "meera";
  } else if (language === "Kannada" || language === "kn-IN") {
    targetLang = "kn-IN";
    speaker = "pavithra";
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
        pitch: 0,
        pace: 1.0,
        loudness: 1.5,
        speech_sample_rate: 22050,
        enable_preprocessing: true,
        model: "bulbul:v1"
      })
    });

    const data: any = await response.json();
    if (data.audios && data.audios.length > 0) {
      return res.json({ audioBase64: data.audios[0], audioFormat: "wav" });
    }
    res.status(400).json({ error: data.message || "Failed to generate TTS from Sarvam" });
  } catch (err: any) {
    console.error("Sarvam TTS error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API: Sarvam AI Speech-to-Text (STT)
app.post("/api/stt", upload.single("audio"), async (req: any, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const { language } = req.body;
    const sarvamKey = process.env.SARVAM_API_KEY || "sk_8fboduyu_lLPqcpjGwCmBBBKaMF7JwsW5";

    let targetLang = "unknown";
    if (language === "Hindi") targetLang = "hi-IN";
    else if (language === "Kannada") targetLang = "kn-IN";
    else if (language === "English") targetLang = "en-IN";

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" });
    formData.append("file", blob, "voice.webm");
    formData.append("language_code", targetLang);
    formData.append("model", "saaras:v1");

    const response = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: {
        "api-subscription-key": sarvamKey,
      },
      body: formData,
    });

    const data: any = await response.json();
    if (data.transcript) {
      return res.json({ transcript: data.transcript });
    }

    res.status(400).json({ error: data.message || "Speech transcription failed" });
  } catch (err: any) {
    console.error("Sarvam STT error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API: Knowledge Base CRUD (Turso Database)
app.get("/api/knowledge", async (req, res) => {
  try {
    const turso = getTurso();
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
    const ai = getGeminiClient();
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

    const result = await ai.models.generateContent({
      model: "gemini-3.7-flash",
      contents: [{ text: promptPayload }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });

    const responseText = result.text || "{}";
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

startServer();
