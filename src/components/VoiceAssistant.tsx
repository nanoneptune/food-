import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Send, AlertCircle, Loader2, Languages, Utensils, Upload, X, Volume2, Sparkles, ChevronDown, ChevronUp, Cpu } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { VoiceInteraction, UserProfile } from '../types';
import ParticleBall from './ParticleBall';
import { transcribeAudioInBrowser } from '../lib/clientWhisper';

function isHallucinatedText(text: string): boolean {
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

export default function VoiceAssistant({ profile }: { profile: UserProfile }) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [transcript, setTranscript] = useState('');
  const [manualText, setManualText] = useState('');
  const [messages, setMessages] = useState<VoiceInteraction[]>([]);
  const [language, setLanguage] = useState<'English' | 'Hindi' | 'Kannada'>('English');
  const [isLoading, setIsLoading] = useState(false);
  const [complaintDraft, setComplaintDraft] = useState<{ query: string; media: string[] } | null>(null);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(typeof window !== 'undefined' ? window.speechSynthesis : null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const transcriptRef = useRef<string>('');
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const silenceTimerRef = useRef<any>(null);
  const isListeningRef = useRef<boolean>(false);
  const isSpeakingRef = useRef<boolean>(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadIntervalRef = useRef<any>(null);
  const hasSpokenRef = useRef<boolean>(false);
  const lastSoundTimeRef = useRef<number>(0);

  const updateListeningState = (val: boolean) => {
    isListeningRef.current = val;
    setIsListening(val);
  };

  const updateSpeakingState = (val: boolean) => {
    isSpeakingRef.current = val;
    setIsSpeaking(val);
  };

  const stopSpeaking = () => {
    if (activeAudioRef.current) {
      try {
        activeAudioRef.current.pause();
        activeAudioRef.current.currentTime = 0;
        activeAudioRef.current = null;
      } catch {}
    }
    if (synthRef.current) {
      try {
        synthRef.current.cancel();
      } catch {}
    }
    updateSpeakingState(false);
  };

  // Auto-scroll chat stream to bottom whenever messages or loading state changes
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, transcript]);

  const startRecording = async () => {
    try {
      if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
      }
      if (vadIntervalRef.current) {
        clearInterval(vadIntervalRef.current);
        vadIntervalRef.current = null;
      }
      if (audioContextRef.current) {
        try { audioContextRef.current.close(); } catch {}
        audioContextRef.current = null;
      }

      hasSpokenRef.current = false;
      lastSoundTimeRef.current = 0;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);
      
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : MediaRecorder.isTypeSupported('audio/webm') 
          ? 'audio/webm' 
          : 'audio/mp4';
      
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };
      
      recorder.start(100); // 100ms timeslice for responsive audio capture

      // AudioContext Voice Activity Detection (VAD) for instant silence response
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          audioContextRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.4;
          source.connect(analyser);

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          
          vadIntervalRef.current = setInterval(() => {
            if (!isListeningRef.current) return;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const average = sum / dataArray.length;

            // Volume threshold for human speech
            if (average > 10) {
              hasSpokenRef.current = true;
              lastSoundTimeRef.current = Date.now();
              if (silenceTimerRef.current) {
                clearTimeout(silenceTimerRef.current);
                silenceTimerRef.current = null;
              }
            } else if (hasSpokenRef.current && lastSoundTimeRef.current > 0) {
              // 1.2 seconds of silence after user spoke -> Auto Stop & Send!
              if (Date.now() - lastSoundTimeRef.current > 1200) {
                hasSpokenRef.current = false;
                lastSoundTimeRef.current = 0;
                stopListeningAndSend();
              }
            }
          }, 100);
        }
      } catch (vadErr) {
        console.warn("VAD audio analyser notice:", vadErr);
      }

      setMicError(null);
    } catch (e: any) { 
      console.warn("Microphone access error:", e);
      setMicError("Microphone access is unavailable or blocked. Please check browser permissions or type your question below.");
    }
  };

  const stopAndTranscribeAudio = async (): Promise<string | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        return resolve(null);
      }

      recorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) return resolve(null);
        
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          if (audioBlob.size < 500) {
            return resolve(null); // Too short to be voice
          }

          const isKannada = language === 'Kannada';

          // 1. If not Kannada, try ultra-fast In-Browser Transformers.js Whisper first
          if (!isKannada) {
            try {
              const inBrowserText = await transcribeAudioInBrowser(audioBlob, language);
              if (inBrowserText && inBrowserText.trim() && !isHallucinatedText(inBrowserText)) {
                return resolve(inBrowserText.trim());
              }
            } catch (browserErr) {
              console.warn("Client Whisper fallback notice:", browserErr);
            }
          }

          // 2. Route to server STT (/api/stt: Sarvam AI Saaras -> Groq Whisper -> Gemini STT Backup)
          const formData = new FormData();
          formData.append('audio', audioBlob, 'speech.webm');
          formData.append('language', language);

          const res = await fetch('/api/stt', { method: 'POST', body: formData });
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await res.json();
            if (res.ok && data.transcript && data.transcript.trim()) {
              return resolve(data.transcript.trim());
            }
          }

          // 3. Last fallback for Kannada: In-Browser Transformers.js multilingual Whisper
          if (isKannada) {
            try {
              const clientText = await transcribeAudioInBrowser(audioBlob, 'Kannada');
              if (clientText && clientText.trim() && !isHallucinatedText(clientText)) {
                return resolve(clientText.trim());
              }
            } catch (clientErr) {
              console.warn("Client Kannada Whisper fallback notice:", clientErr);
            }
          }

          resolve(null);
        } catch (e) {
          console.warn("STT transcription notice:", e);
          resolve(null);
        }
      };

      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });
  };

  const stopAndUploadAudio = async (): Promise<string | undefined> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        return resolve(undefined);
      }
      
      recorder.onstop = async () => {
        if (audioChunksRef.current.length === 0) return resolve(undefined);
        const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const formData = new FormData();
        formData.append('file', audioBlob);
        try {
          const res = await fetch('/api/upload', { method: 'POST', body: formData });
          const data = await res.json();
          resolve(data.url);
        } catch (e) { 
          resolve(undefined); 
        }
      };
      try {
        recorder.stop();
      } catch {
        resolve(undefined);
      }
    });
  };

  // Re-configure speech recognition whenever language changes
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    try {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }

      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        
        // Assign language code
        if (language === 'Hindi') recognition.lang = 'hi-IN';
        else if (language === 'Kannada') recognition.lang = 'kn-IN';
        else recognition.lang = 'en-US';

        recognition.onstart = () => {
          updateListeningState(true);
          setMicError(null);
        };

        recognition.onresult = (event: any) => {
          let interimTranscript = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const piece = event.results[i][0].transcript;
            interimTranscript += piece;
          }
          if (interimTranscript.trim()) {
            transcriptRef.current = interimTranscript;
            setTranscript(interimTranscript);
            hasSpokenRef.current = true;
            lastSoundTimeRef.current = Date.now();

            // User barge-in: If user speaks while AI audio is active, stop AI speech immediately
            if (isSpeakingRef.current || activeAudioRef.current) {
              stopSpeaking();
            }

            // Auto Silence Detection: After 1.2s of no new spoken words, automatically finish & respond!
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
            }
            silenceTimerRef.current = setTimeout(() => {
              if (isListeningRef.current) {
                stopListeningAndSend();
              }
            }, 1200);
          }
        };

        recognition.onspeechend = () => {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          silenceTimerRef.current = setTimeout(() => {
            if (isListeningRef.current) {
              stopListeningAndSend();
            }
          }, 600);
        };

        recognition.onerror = (event: any) => {
          console.warn('Browser speech recognition notice:', event.error);
          if (event.error === 'not-allowed') {
            setMicError("Microphone access blocked in browser. Please enable permissions.");
          }
        };

        recognition.onend = async () => {
          const capturedText = transcriptRef.current?.trim();
          if (capturedText && isListeningRef.current) {
            stopListeningAndSend();
          }
        };

        recognitionRef.current = recognition;
      }
    } catch (err) {
      console.warn("Speech recognition initialization error", err);
    }
  }, [language]);

  const fallbackBrowserSpeak = (text: string) => {
    if (!synthRef.current || !text) return;
    try {
      synthRef.current.cancel();
      const cleanedForSpeech = text
        .replace(/[*#_`~\[\]\(\)]/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .trim();

      const utterance = new SpeechSynthesisUtterance(cleanedForSpeech);
      if (language === 'Hindi') utterance.lang = 'hi-IN';
      else if (language === 'Kannada') utterance.lang = 'kn-IN';
      else utterance.lang = 'en-US';

      utterance.onstart = () => updateSpeakingState(true);
      utterance.onend = () => updateSpeakingState(false);
      utterance.onerror = () => updateSpeakingState(false);
      synthRef.current.speak(utterance);
    } catch (e) {
      console.warn("Browser synthesis error:", e);
      updateSpeakingState(false);
    }
  };

  const speak = async (text: string) => {
    if (!text) return;

    stopSpeaking();

    try {
      // 1. Generate natural speech using Sarvam AI TTS
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language })
      });

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (data && data.audioBase64) {
          const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`);
          audio.onplay = () => updateSpeakingState(true);
          audio.onended = () => updateSpeakingState(false);
          audio.onerror = () => {
            updateSpeakingState(false);
            fallbackBrowserSpeak(text);
          };
          activeAudioRef.current = audio;
          await audio.play();
          return;
        }
      }
    } catch (err) {
      console.warn("Sarvam TTS request notice (using browser speech fallback):", err);
    }

    // 2. Fallback to browser SpeechSynthesis
    fallbackBrowserSpeak(text);
  };

  const stopListeningAndSend = async () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    hasSpokenRef.current = false;
    lastSoundTimeRef.current = 0;
    updateListeningState(false);

    try {
      recognitionRef.current?.stop();
    } catch (e) {
      console.warn(e);
    }

    const browserCaptured = transcriptRef.current.trim();
    
    // Always call the high-quality backend STT (Saaras v4 / Groq Whisper) first for superior accuracy
    setIsLoading(true);
    const serverText = await stopAndTranscribeAudio();
    setIsLoading(false);

    if (serverText && serverText.trim() && !isHallucinatedText(serverText)) {
      setTranscript(serverText.trim());
      transcriptRef.current = '';
      handleSendMessage(serverText.trim());
    } else if (browserCaptured && !isHallucinatedText(browserCaptured)) {
      // Fallback to browser's native text if backend returned empty
      setTranscript(browserCaptured);
      transcriptRef.current = '';
      handleSendMessage(browserCaptured);
    } else {
      setTranscript('');
      transcriptRef.current = '';
    }
  };

  const startListeningProcess = async () => {
    stopSpeaking();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setTranscript('');
    transcriptRef.current = '';
    updateListeningState(true);
    await startRecording();
    try {
      recognitionRef.current?.start();
    } catch (e) {
      console.warn("Native recognition start notice (falling back cleanly to audio recorder):", e);
    }
  };

  const toggleListening = async () => {
    // 1. If AI is speaking -> INTERRUPT! Stop speech immediately and start listening to user
    if (isSpeakingRef.current || isSpeaking || activeAudioRef.current) {
      await startListeningProcess();
      return;
    }

    // 2. If listening -> User clicked mic again to stop! Stop listening & send immediately
    if (isListeningRef.current || isListening) {
      await stopListeningAndSend();
      return;
    }

    // 3. Otherwise -> Start listening
    await startListeningProcess();
  };

  const handleMediaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !complaintDraft) return;
    setIsUploadingMedia(true);
    try {
      const urls: string[] = [...complaintDraft.media];
      const fileArray = Array.from(files);
      for (const file of fileArray) {
        const formData = new FormData();
        formData.append('file', file as Blob);
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        urls.push(data.url);
      }
      setComplaintDraft({ ...complaintDraft, media: urls });
    } catch (e) { console.error(e); } finally { setIsUploadingMedia(false); }
  };

  const handleSendMessage = async (text: string) => {
    const queryText = text?.trim();
    if (!queryText) return;

    const userMsg: VoiceInteraction = { 
      id: Date.now().toString(), 
      text: queryText, 
      sender: 'user', 
      timestamp: Date.now() 
    };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    setTranscript('');
    transcriptRef.current = '';
    setManualText('');

    // Check for confirmation if a complaint was drafted
    if (complaintDraft && (
      queryText.toLowerCase().includes('yes') || 
      queryText.toLowerCase().includes('confirm') || 
      queryText.toLowerCase().includes('okay') || 
      queryText.toLowerCase().includes('ha') || 
      queryText.toLowerCase().includes('sari')
    )) {
      await finalizeComplaint();
      return;
    }

    const recentHistory = messages.slice(-8).map(m => ({
      role: m.sender === 'user' ? 'user' : 'assistant',
      content: m.text
    }));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: queryText, 
          history: recentHistory,
          language, 
          profile 
        })
      });

      let data: any = {};
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        throw new Error('Server returned non-JSON response');
      }

      if (!res.ok || data.error) {
        throw new Error(data.error || 'Server failed to respond');
      }
      
      const assistantReply = data.response || "I have received your query. How else may I assist you?";
      const assistantMsg: VoiceInteraction = { 
        id: (Date.now() + 1).toString(), 
        text: assistantReply, 
        sender: 'assistant', 
        timestamp: Date.now() 
      };
      
      setMessages(prev => [...prev, assistantMsg]);
      speak(assistantReply);

      // Detect if AI suggested a complaint
      if (data.isComplaintDraft) {
        setComplaintDraft({ query: queryText, media: [] });
      }
    } catch (error: any) { 
      console.error("Chat error:", error);
      let errorText = "I'm having trouble connecting to the AI service. Please verify your API key (GROQ_API_KEY) in Vercel environment settings.";
      if (language === 'Kannada' || language === 'kn-IN') {
        errorText = "ಸಂಪರ್ಕಿಸುವಲ್ಲಿ ಸಮಸ್ಯೆ ಉಂಟಾಗಿದೆ. ದಯವಿಟ್ಟು Vercel ಪರಿರಚನೆಯಲ್ಲಿ ನಿಮ್ಮ API ಕೀಲಿಯನ್ನು (GROQ_API_KEY) ಪರಿಶೀಲಿಸಿ.";
      } else if (language === 'Hindi' || language === 'hi-IN') {
        errorText = "कनेक्ट करने में समस्या आ रही है। कृपया Vercel सेटिंग्स में अपनी API कुंजी (GROQ_API_KEY) की जाँच करें।";
      }

      const fallbackMsg: VoiceInteraction = {
        id: (Date.now() + 1).toString(),
        text: errorText,
        sender: 'assistant',
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, fallbackMsg]);
      speak(fallbackMsg.text);
    } finally { 
      setIsLoading(false); 
      setTranscript(''); 
    }
  };

  const finalizeComplaint = async () => {
    if (!complaintDraft) return;
    setIsLoading(true);
    const audioUrl = await stopAndUploadAudio();
    const complaintId = Date.now().toString();
    const complaintData = {
      id: complaintId,
      name: profile.name || 'Anonymous',
      phoneNumber: profile.phone || 'N/A',
      location: profile.location || '',
      query: complaintDraft.query,
      status: 'pending',
      chatHistory: messages,
      mediaUrls: complaintDraft.media,
      audioUrl: audioUrl,
      createdAt: Date.now(),
      adminReply: '',
      adminReplyAt: null,
    };
    
    try {
      // Save directly to Turso database via server API
      const res = await fetch('/api/complaints/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(complaintData)
      });
      
      if (!res.ok) {
        throw new Error("Failed to register complaint");
      }
      
      const successMsg: VoiceInteraction = { 
        id: Date.now().toString(), 
        text: "Your report has been successfully registered! Our support team will review your audio and details. You can track progress anytime in Track Reports.", 
        sender: 'assistant', 
        timestamp: Date.now() 
      };
      setMessages(prev => [...prev, successMsg]);
      speak(successMsg.text);
      setComplaintDraft(null);
    } catch (e) { 
      console.error('Error finalizing complaint:', e); 
    } finally { 
      setIsLoading(false); 
    }
  };

  const hasMessages = messages.length > 0;
  const [isMinimized, setIsMinimized] = useState(false);

  // If user sends a new message while minimized, un-minimize automatically
  const showFullChat = hasMessages && !isMinimized;

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col h-[calc(100vh-8rem)] max-w-lg mx-auto relative px-3 sm:px-4"
    >
      {/* Mic Error Banner */}
      {micError && (
        <div className="shrink-0 mb-2 bg-rose-50 border border-rose-200 text-rose-800 p-2.5 rounded-2xl flex items-start gap-2 text-xs shadow-sm z-30">
          <AlertCircle size={15} className="text-rose-500 shrink-0 mt-0.5" />
          <div className="flex-1 font-semibold">{micError}</div>
          <button onClick={() => setMicError(null)} className="text-rose-400 hover:text-rose-600">
            <X size={14} />
          </button>
        </div>
      )}

      <AnimatePresence mode="wait">
        {!showFullChat ? (
          /* ========================================================
             1. MAIN LANDING PAGE: Big 3D Sphere in Middle & assist heading
             ======================================================== */
          <motion.div
            key="landing-orb"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col items-center justify-between py-2 min-h-0"
          >
            {/* Top Language Switcher Bar */}
            <div className="shrink-0 flex justify-center gap-1.5 p-1 bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200 shadow-sm w-fit mx-auto mt-1">
              {(['English', 'Hindi', 'Kannada'] as const).map((lang) => {
                const labelMap = { English: 'English', Hindi: 'हिन्दी', Kannada: 'ಕನ್ನಡ' };
                return (
                  <button
                    key={lang}
                    onClick={() => {
                      setLanguage(lang);
                      if (synthRef.current) synthRef.current.cancel();
                    }}
                    className={`px-3.5 py-1.5 rounded-xl text-[11px] font-bold tracking-wide transition-all ${
                      language === lang 
                        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200' 
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    {labelMap[lang]}
                  </button>
                );
              })}
            </div>

            {/* Middle Big 3D Sphere */}
            <div className="flex-1 flex flex-col items-center justify-center py-4 space-y-4">
              <ParticleBall
                isListening={isListening}
                isSpeaking={isSpeaking}
                isLoading={isLoading}
                onClick={toggleListening}
                audioStream={micStream}
                compact={false}
              />

              <div className="text-center max-w-sm px-2">
                <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
                  {isListening 
                    ? "Listening to your voice..." 
                    : isSpeaking 
                    ? "Speaking answer..." 
                    : isLoading 
                    ? "Thinking..." 
                    : "How can I help you today?"}
                </h2>
                <div className="mt-1 min-h-5">
                  <AnimatePresence mode="wait">
                    <motion.p 
                      key={transcript || (isListening ? 'listening' : 'idle')}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-indigo-600 font-bold text-xs tracking-wide px-2"
                    >
                      {transcript || (
                        isListening 
                          ? "Listening... Speak your query clearly" 
                          : (language === 'Kannada' 
                              ? "ಧ್ವನಿ ಮೂಲಕ ಮಾತನಾಡಲು ಗೋಳವನ್ನು ಟ್ಯಾಪ್ ಮಾಡಿ" 
                              : language === 'Hindi' 
                              ? "बोलने के लिए गोले पर टैप करें" 
                              : "Tap sphere above or type below to send message")
                      )}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>
            </div>

            {/* If there are existing messages and user minimized, show toggle to re-open chat */}
            {hasMessages && (
              <button
                onClick={() => setIsMinimized(false)}
                className="shrink-0 mb-1 px-4 py-1.5 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-700 text-xs font-bold rounded-xl flex items-center gap-1.5 shadow-sm transition-all"
              >
                <span>View Chat History ({messages.length})</span>
                <ChevronUp size={14} />
              </button>
            )}
          </motion.div>
        ) : (
          /* ========================================================
             2. FULL CHAT STREAM: Expands and Fills Page on message send
             ======================================================== */
          <motion.div
            key="chat-full"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 15 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Top Compact Header: Small Sphere + Clear Eng/Hi/Kan + Corner Minimize Button */}
            <div className="shrink-0 flex items-center justify-between gap-2 p-2 bg-white/95 backdrop-blur-xl rounded-2xl border border-slate-200/90 shadow-sm z-10 mb-1">
              <div className="flex items-center gap-2">
                <ParticleBall
                  isListening={isListening}
                  isSpeaking={isSpeaking}
                  isLoading={isLoading}
                  onClick={toggleListening}
                  audioStream={micStream}
                  compact={true}
                />
                <div>
                  <h3 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                    <span>VoxAssist AI</span>
                    {isListening && <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />}
                  </h3>
                  <p className="text-[10px] text-indigo-600 font-bold truncate max-w-[110px] sm:max-w-[150px]">
                    {transcript || (
                      isListening 
                        ? "Listening..." 
                        : isSpeaking 
                        ? "Speaking..." 
                        : isLoading 
                        ? "Thinking..." 
                        : "Active Chat"
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                {/* Clear Eng | Hi | Kan Language Switcher */}
                <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-xl border border-slate-200/60">
                  {(['English', 'Hindi', 'Kannada'] as const).map((lang) => {
                    const labelMap = { English: 'Eng', Hindi: 'Hi', Kannada: 'Kan' };
                    return (
                      <button
                        key={lang}
                        onClick={() => {
                          setLanguage(lang);
                          if (synthRef.current) synthRef.current.cancel();
                        }}
                        className={`px-2 py-1 rounded-lg text-[10px] sm:text-xs font-bold transition-all ${
                          language === lang 
                            ? 'bg-indigo-600 text-white shadow-xs' 
                            : 'text-slate-600 hover:text-slate-900 hover:bg-white'
                        }`}
                        title={`Switch to ${lang}`}
                      >
                        {labelMap[lang]}
                      </button>
                    );
                  })}
                </div>

                {/* Corner Minimize Button */}
                <button
                  onClick={() => setIsMinimized(true)}
                  className="p-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors border border-slate-200"
                  title="Minimize chat to main sphere"
                >
                  <ChevronDown size={16} />
                </button>
              </div>
            </div>

            {/* Main Full Chat Stream Container */}
            <div className="flex-1 overflow-y-auto py-2 space-y-3 custom-scrollbar flex flex-col pr-1 min-h-0 my-1">
              <AnimatePresence initial={false}>
                {messages.map((m) => (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 14, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                    className={`p-3.5 rounded-2xl max-w-[88%] shadow-sm ${
                      m.sender === 'user' 
                      ? 'bg-indigo-600 text-white self-end shadow-indigo-100 rounded-br-xs' 
                      : 'bg-white text-slate-800 self-start border border-slate-200/80 rounded-bl-xs'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs sm:text-sm font-medium leading-relaxed">{m.text}</p>
                      {m.sender === 'assistant' && (
                        <button 
                          onClick={() => speak(m.text)}
                          className="text-indigo-400 hover:text-indigo-600 p-1 rounded-lg shrink-0 transition-colors"
                          title="Replay Voice"
                        >
                          <Volume2 size={15} />
                        </button>
                      )}
                    </div>
                    <div className={`text-[9px] font-bold uppercase tracking-wider mt-1.5 opacity-60 ${m.sender === 'user' ? 'text-right text-indigo-100' : 'text-left text-slate-400'}`}>
                      {m.sender === 'user' ? (profile.name || 'You') : 'VoxAssist AI'} • {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {isLoading && (
                <div className="flex items-center gap-2 bg-white w-fit px-3.5 py-2.5 rounded-2xl border border-slate-200 shadow-sm text-indigo-600 self-start">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-[11px] font-bold uppercase tracking-wider">Generating answer...</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* STICKY BOTTOM CHAT INPUT BAR: High-contrast, ultra-visible while typing */}
      <div className="shrink-0 sticky bottom-0 bg-slate-50/95 backdrop-blur-md pt-2 pb-1 space-y-2 border-t border-slate-200/80 z-20">
        {/* Complaint Drafting Box */}
        {complaintDraft && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-amber-50 border-2 border-amber-300 p-3 rounded-2xl space-y-2 shadow-md"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <AlertCircle size={16} className="text-amber-600" />
                <p className="text-xs font-bold text-amber-900 uppercase tracking-wide">Issue Report Drafted</p>
              </div>
              <button 
                onClick={() => mediaInputRef.current?.click()}
                disabled={isUploadingMedia}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-white text-amber-800 border border-amber-300 rounded-lg text-[10px] font-bold uppercase tracking-wider shadow-sm hover:bg-amber-50"
              >
                {isUploadingMedia ? <Loader2 className="animate-spin" size={12} /> : <Upload size={12} />} 
                Add Photos
              </button>
              <input 
                type="file" 
                ref={mediaInputRef} 
                className="hidden" 
                multiple 
                accept="image/*,.pdf" 
                onChange={handleMediaUpload}
              />
            </div>

            {complaintDraft.media.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {complaintDraft.media.map((url, i) => (
                  <div key={i} className="w-10 h-10 rounded-lg bg-white border border-amber-200 overflow-hidden relative group">
                    <img src={url} className="w-full h-full object-cover" alt="attachment" />
                    <button 
                      onClick={() => setComplaintDraft({ ...complaintDraft, media: complaintDraft.media.filter((_, idx) => idx !== i) })}
                      className="absolute inset-0 bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between pt-0.5">
              <p className="text-[10px] text-amber-800 font-medium">
                Say <span className="font-bold">"Yes"</span> or tap confirm to submit.
              </p>
              <button
                onClick={finalizeComplaint}
                disabled={isLoading}
                className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-colors shadow-sm"
              >
                Confirm Report
              </button>
            </div>
          </motion.div>
        )}

        {/* High-Contrast Visible Chat Input Box */}
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            if (manualText.trim()) {
              setIsMinimized(false);
              handleSendMessage(manualText);
            }
          }}
          className="flex items-center gap-2 bg-white p-2 sm:p-2.5 rounded-2xl border-2 border-indigo-500/90 shadow-xl shadow-indigo-100/70 focus-within:border-indigo-600 focus-within:ring-2 focus-within:ring-indigo-300 transition-all"
        >
          <button
            type="button"
            onClick={() => {
              setIsMinimized(false);
              toggleListening();
            }}
            className={`p-2.5 rounded-xl transition-all ${
              isListening 
                ? 'bg-red-500 text-white animate-pulse shadow-md shadow-red-200' 
                : 'bg-indigo-50 text-indigo-600 border border-indigo-200 hover:bg-indigo-100 active:scale-95'
            }`}
            title={isListening ? "Stop Listening" : "Start Voice Input"}
          >
            {isListening ? <MicOff size={18} /> : <Mic size={18} />}
          </button>

          <input
            type="text"
            placeholder={
              language === 'Kannada' 
                ? "ಇಲ್ಲಿ ಸಂದೇಶ ಟೈಪ್ ಮಾಡಿ..." 
                : language === 'Hindi' 
                ? "यहाँ अपना प्रश्न टाइप करें..." 
                : "Type your query or complaint here..."
            }
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            className="flex-1 bg-slate-50 focus:bg-white px-3 py-2 text-xs sm:text-sm font-semibold text-slate-900 placeholder-slate-400 focus:outline-none rounded-xl border border-slate-200 focus:border-indigo-500 transition-all"
          />

          <button
            type="submit"
            disabled={!manualText.trim() || isLoading}
            className="p-2.5 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white rounded-xl transition-all disabled:opacity-40 shadow-md shadow-indigo-200 flex items-center justify-center shrink-0"
          >
            <Send size={16} />
          </button>
        </form>

        {/* Identity Alert */}
        {!profile.name && (
          <div className="bg-indigo-50/70 p-2 rounded-xl border border-indigo-100 flex items-center gap-2">
            <Sparkles size={14} className="text-indigo-600 shrink-0" />
            <p className="text-[10px] text-indigo-900 font-medium">
              Tip: Set your name and phone in profile to personalize answers.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

