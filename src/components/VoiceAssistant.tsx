import React, { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { collection, addDoc, getDocs } from 'firebase/firestore';
import { Mic, MicOff, Send, AlertCircle, Loader2, Languages, Utensils, Upload, X, Volume2, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { VoiceInteraction, UserProfile } from '../types';
import ParticleBall from './ParticleBall';

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
  
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(typeof window !== 'undefined' ? window.speechSynthesis : null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const transcriptRef = useRef<string>('');

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mediaRecorderRef.current.start();
      setMicError(null);
    } catch (e) { 
      console.warn("Microphone media recorder error:", e);
      setMicError("Microphone permission was denied. You can also type your message below.");
    }
  };

  const stopAndUploadAudio = async (): Promise<string | undefined> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
        return resolve(undefined);
      }
      
      mediaRecorderRef.current.onstop = async () => {
        if (audioChunksRef.current.length === 0) return resolve(undefined);
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
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
        mediaRecorderRef.current.stop();
      } catch {
        resolve(undefined);
      }
    });
  };

  // Re-configure speech recognition whenever language changes
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setMicError("Speech recognition is not supported in this browser. Please use Google Chrome or Edge, or type your query below.");
      return;
    }

    try {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      
      // Assign language code
      if (language === 'Hindi') recognition.lang = 'hi-IN';
      else if (language === 'Kannada') recognition.lang = 'kn-IN';
      else recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setMicError(null);
      };

      recognition.onresult = (event: any) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const piece = event.results[i][0].transcript;
          interimTranscript += piece;
        }
        transcriptRef.current = interimTranscript;
        setTranscript(interimTranscript);
      };

      recognition.onerror = (event: any) => {
        console.warn('Speech recognition error event:', event.error);
        if (event.error === 'not-allowed') {
          setMicError("Microphone access was blocked. Please enable microphone permissions in your browser bar.");
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
        const capturedText = transcriptRef.current?.trim();
        if (capturedText) {
          handleSendMessage(capturedText);
          transcriptRef.current = '';
        }
      };

      recognitionRef.current = recognition;
    } catch (err) {
      console.warn("Speech recognition initialization error", err);
    }
  }, [language]);

  const speak = (text: string) => {
    if (!synthRef.current || !text) return;
    try {
      synthRef.current.cancel(); // Cancel any ongoing speech
      
      // Clean up markdown markers or code brackets before speaking out loud
      const cleanedForSpeech = text
        .replace(/[*#_`~\[\]\(\)]/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .trim();

      const utterance = new SpeechSynthesisUtterance(cleanedForSpeech);
      
      if (language === 'Hindi') {
        utterance.lang = 'hi-IN';
      } else if (language === 'Kannada') {
        utterance.lang = 'kn-IN';
      } else {
        utterance.lang = 'en-US';
      }

      // Try selecting a natural voice matching the locale
      const voices = synthRef.current.getVoices();
      if (voices && voices.length > 0) {
        const targetLocale = language === 'Hindi' ? 'hi' : language === 'Kannada' ? 'kn' : 'en';
        const matchedVoice = voices.find(v => v.lang.toLowerCase().startsWith(targetLocale));
        if (matchedVoice) utterance.voice = matchedVoice;
      }
      
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = (e) => {
        console.warn("Speech synthesis error", e);
        setIsSpeaking(false);
      };

      synthRef.current.speak(utterance);
    } catch (e) {
      console.warn("Speech synthesis trigger error", e);
      setIsSpeaking(false);
    }
  };

  const toggleListening = () => {
    if (isListening) {
      try {
        recognitionRef.current?.stop();
      } catch (e) {
        console.warn(e);
      }
      setIsListening(false);
    } else {
      setTranscript('');
      transcriptRef.current = '';
      try {
        recognitionRef.current?.start();
        setIsListening(true);
        startRecording();
      } catch (e) {
        console.warn("Recognition start failed or already active", e);
        try {
          recognitionRef.current?.stop();
          setTimeout(() => {
            recognitionRef.current?.start();
            setIsListening(true);
            startRecording();
          }, 150);
        } catch {}
      }
    }
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

    try {
      let context = '';
      try {
        const kbSnap = await getDocs(collection(db, 'knowledge_base'));
        context = kbSnap.docs.map(doc => doc.data().content).join('\n');
      } catch (e) {
        console.warn("Could not fetch Firestore KB context, proceeding:", e);
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: queryText, 
          context, 
          language, 
          profile 
        })
      });

      const data = await res.json();
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
      const fallbackMsg: VoiceInteraction = {
        id: (Date.now() + 1).toString(),
        text: "I'm having trouble connecting right now. Please verify your connection or API key settings.",
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
      // 1. Save to SQLite / Turso database via server API
      await fetch('/api/complaints/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(complaintData)
      });

      // 2. Also sync to Firestore
      try {
        await addDoc(collection(db, 'complaints'), complaintData);
      } catch (firestoreErr) {
        console.warn('Firestore sync optional:', firestoreErr);
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

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="px-6 flex flex-col items-center min-h-[80vh]"
    >
      <div className="w-full max-w-lg space-y-6">
        {/* Language Switcher Bar */}
        <div className="flex justify-center gap-2 p-1.5 bg-white/70 backdrop-blur-xl rounded-2xl border border-slate-100 shadow-sm w-fit mx-auto">
          {(['English', 'Hindi', 'Kannada'] as const).map((lang) => (
            <button
              key={lang}
              onClick={() => {
                setLanguage(lang);
                if (synthRef.current) synthRef.current.cancel();
              }}
              className={`px-4 py-2 rounded-xl text-[11px] font-bold tracking-wide transition-all ${
                language === lang 
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200' 
                  : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
              }`}
            >
              {lang === 'Kannada' ? 'ಕನ್ನಡ' : lang === 'Hindi' ? 'हिन्दी' : 'English'}
            </button>
          ))}
        </div>

        {/* Mic Error Notice */}
        {micError && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 p-3.5 rounded-2xl flex items-start gap-2.5 text-xs">
            <AlertCircle size={16} className="text-rose-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">{micError}</p>
            </div>
            <button onClick={() => setMicError(null)} className="text-rose-400 hover:text-rose-600">
              <X size={14} />
            </button>
          </div>
        )}

        {/* 3D Sphere Voice Orb */}
        <div className="relative flex flex-col items-center justify-center py-4">
          <ParticleBall
            isListening={isListening}
            isSpeaking={isSpeaking}
            isLoading={isLoading}
            onClick={toggleListening}
            audioStream={micStream}
          />

          <div className="mt-6 text-center max-w-sm">
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">
              {isListening ? "Listening to your voice..." : isSpeaking ? "Speaking answer..." : isLoading ? "Thinking..." : "How can I help you today?"}
            </h2>
            <div className="mt-2 min-h-6">
              <AnimatePresence mode="wait">
                <motion.p 
                  key={transcript || (isListening ? 'listening' : 'idle')}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-indigo-600 font-bold text-xs tracking-wide px-4"
                >
                  {transcript || (
                    isListening 
                      ? "Listening... Speak now" 
                      : (language === 'Kannada' ? "ಧ್ವನಿ ಮೂಲಕ ಮಾತನಾಡಲು ಗೋಳವನ್ನು ಟ್ಯಾಪ್ ಮಾಡಿ" : language === 'Hindi' ? "बोलने के लिए गोले पर टैप करें" : "Tap the sphere or type below to talk")
                  )}
                </motion.p>
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Text Input Fallback Bar */}
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            handleSendMessage(manualText);
          }}
          className="flex items-center gap-2 bg-white p-2 rounded-2xl border border-slate-200 shadow-sm"
        >
          <input
            type="text"
            placeholder={language === 'Kannada' ? "ಇಲ್ಲಿ ಸಂದೇಶ ಟೈಪ್ ಮಾಡಿ..." : language === 'Hindi' ? "यहाँ अपना प्रश्न टाइप करें..." : "Or type your food query or complaint..."}
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            className="flex-1 bg-transparent px-3 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none font-medium"
          />
          <button
            type="submit"
            disabled={!manualText.trim() || isLoading}
            className="p-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl transition-all disabled:opacity-40 active:scale-95 shadow-sm"
          >
            <Send size={15} />
          </button>
        </form>

        {/* Dialogue Stream */}
        <div className="space-y-4 max-h-[35vh] overflow-y-auto pr-2 custom-scrollbar flex flex-col pb-4">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`p-4 rounded-3xl max-w-[88%] ${
                  m.sender === 'user' 
                  ? 'bg-indigo-600 text-white self-end shadow-md shadow-indigo-100' 
                  : 'bg-white text-slate-800 self-start border border-slate-100 shadow-sm'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-medium leading-relaxed">{m.text}</p>
                  {m.sender === 'assistant' && (
                    <button 
                      onClick={() => speak(m.text)}
                      className="text-indigo-400 hover:text-indigo-600 p-1 rounded-lg shrink-0 transition-colors"
                      title="Replay Voice"
                    >
                      <Volume2 size={14} />
                    </button>
                  )}
                </div>
                <div className={`text-[9px] font-bold uppercase tracking-wider mt-2 opacity-60 ${m.sender === 'user' ? 'text-right text-indigo-100' : 'text-left text-slate-400'}`}>
                  {m.sender === 'user' ? (profile.name || 'You') : 'VoxAssist AI'} • {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {isLoading && (
            <div className="flex items-center gap-2.5 bg-white w-fit px-4 py-2.5 rounded-2xl border border-slate-100 shadow-sm text-indigo-600">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="text-[11px] font-bold uppercase tracking-wider">Generating answer...</span>
            </div>
          )}
        </div>

        {/* Complaint Drafting Media Support */}
        {complaintDraft && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-amber-50/80 border border-amber-200 p-5 rounded-3xl space-y-3 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle size={16} className="text-amber-600" />
                <p className="text-xs font-bold text-amber-900 uppercase tracking-wide">Issue Report Drafted</p>
              </div>
              <button 
                onClick={() => mediaInputRef.current?.click()}
                disabled={isUploadingMedia}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-amber-800 border border-amber-200 rounded-xl text-[10px] font-bold uppercase tracking-wider shadow-sm hover:bg-amber-50"
              >
                {isUploadingMedia ? <Loader2 className="animate-spin" size={13} /> : <Upload size={13} />} 
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
                  <div key={i} className="w-12 h-12 rounded-xl bg-white border border-amber-200 overflow-hidden relative group">
                    <img src={url} className="w-full h-full object-cover" alt="attachment" />
                    <button 
                      onClick={() => setComplaintDraft({ ...complaintDraft, media: complaintDraft.media.filter((_, idx) => idx !== i) })}
                      className="absolute inset-0 bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <p className="text-[11px] text-amber-800 font-medium">
                Say <span className="font-bold">"Yes"</span> or tap confirm to submit this report.
              </p>
              <button
                onClick={finalizeComplaint}
                disabled={isLoading}
                className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-colors shadow-sm"
              >
                Confirm Report
              </button>
            </div>
          </motion.div>
        )}

        {/* Identity Alert */}
        {!profile.name && (
          <div className="bg-indigo-50/60 p-3.5 rounded-2xl border border-indigo-100 flex items-center gap-2.5">
            <Sparkles size={16} className="text-indigo-600 shrink-0" />
            <p className="text-xs text-indigo-900 font-medium">
              Tip: Set your name and phone in the top profile to receive personalized voice responses.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

