import React, { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { collection, addDoc, query, where, getDocs } from 'firebase/firestore';
import { Mic, MicOff, Send, AlertCircle, Loader2, Languages, Utensils, Upload, X, Database } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { VoiceInteraction, UserProfile } from '../types';
import ParticleBall from './ParticleBall';

export default function VoiceAssistant({ profile }: { profile: UserProfile }) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [transcript, setTranscript] = useState('');
  const [messages, setMessages] = useState<VoiceInteraction[]>([]);
  const [language, setLanguage] = useState<'English' | 'Hindi' | 'Kannada'>('English');
  const [isLoading, setIsLoading] = useState(false);
  const [complaintDraft, setComplaintDraft] = useState<{ query: string; media: string[] } | null>(null);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis>(window.speechSynthesis);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mediaRecorderRef.current.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      mediaRecorderRef.current.start();
    } catch (e) { console.error("Mic access denied"); }
  };

  const stopAndUploadAudio = async (): Promise<string | undefined> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current) return resolve(undefined);
      
      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('file', audioBlob);
        try {
          const res = await fetch('/api/upload', { method: 'POST', body: formData });
          const data = await res.json();
          resolve(data.url);
        } catch (e) { resolve(undefined); }
      };
      mediaRecorderRef.current.stop();
    });
  };

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.onresult = (event: any) => {
        const current = event.resultIndex;
        const result = event.results[current][0].transcript;
        setTranscript(result);
      };
      recognitionRef.current.onend = () => {
        setIsListening(false);
      };
    }
  }, []);

  const speak = (text: string) => {
    try {
      synthRef.current.cancel(); // Cancel any ongoing speech
      const utterance = new SpeechSynthesisUtterance(text);
      if (language === 'Hindi') utterance.lang = 'hi-IN';
      else if (language === 'Kannada') utterance.lang = 'kn-IN';
      else utterance.lang = 'en-US';
      
      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      synthRef.current.speak(utterance);
    } catch (e) {
      console.warn("Speech synthesis error", e);
      setIsSpeaking(false);
    }
  };

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      setTranscript('');
      try {
        recognitionRef.current?.start();
      } catch (e) {
        console.warn("Recognition start failed or already active", e);
      }
      setIsListening(true);
      startRecording();
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
    if (!text.trim()) return;
    const userMsg: VoiceInteraction = { id: Date.now().toString(), text, sender: 'user', timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);

    // Check for confirmation if a complaint was drafted
    if (complaintDraft && (text.toLowerCase().includes('yes') || text.toLowerCase().includes('confirm') || text.toLowerCase().includes('okay') || text.toLowerCase().includes('ha') || text.toLowerCase().includes('sari'))) {
      await finalizeComplaint();
      return;
    }

    try {
      const kbSnap = await getDocs(collection(db, 'knowledge_base'));
      const context = kbSnap.docs.map(doc => doc.data().content).join('\n');
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context, language, profile })
      });
      const data = await res.json();
      
      const assistantMsg: VoiceInteraction = { id: (Date.now() + 1).toString(), text: data.response, sender: 'assistant', timestamp: Date.now() };
      setMessages(prev => [...prev, assistantMsg]);
      speak(data.response);

      // Detect if AI suggested a complaint
      if (data.isComplaintDraft) {
        setComplaintDraft({ query: text, media: [] });
      }
    } catch (error) { 
      console.error(error); 
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
        text: "Registered! I've uploaded your audio report and details. Our team will look into it and you can track status directly in Track Reports.", 
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
      <div className="w-full max-w-lg space-y-8">
        <div className="flex justify-center gap-2 p-1 bg-white/50 backdrop-blur-xl rounded-2xl mb-4 border border-white shadow-sm w-fit mx-auto">
          {(['English', 'Hindi', 'Kannada'] as const).map((lang) => (
            <button
              key={lang}
              onClick={() => setLanguage(lang)}
              className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${
                language === lang ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {lang === 'Kannada' ? 'ಕನ್ನಡ' : lang === 'Hindi' ? 'हिन्दी' : 'EN'}
            </button>
          ))}
        </div>

        <div className="relative flex flex-col items-center justify-center py-6">
          <ParticleBall
            isListening={isListening}
            isSpeaking={isSpeaking}
            isLoading={isLoading}
            onClick={toggleListening}
            audioStream={micStream}
          />

          <div className="mt-8 text-center max-w-sm">
            <h2 className="text-2xl font-bold text-slate-900 tracking-tight">
              {isListening ? "Listening..." : isSpeaking ? "Speaking..." : "How can I help?"}
            </h2>
            <div className="mt-2 h-6">
              <AnimatePresence mode="wait">
                <motion.p 
                  key={transcript || 'idle'}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-indigo-600 font-bold text-sm tracking-wide"
                >
                  {transcript || (language === 'Kannada' ? "ಕೇಳಲು ಟ್ಯಾಪ್ ಮಾಡಿ" : language === 'Hindi' ? "सुनने के लिए टैप करें" : "Tap the sphere to talk")}
                </motion.p>
              </AnimatePresence>
            </div>
          </div>
        </div>

        <div className="space-y-4 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar flex flex-col pb-8">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`p-5 rounded-[2rem] max-w-[85%] ${
                  m.sender === 'user' 
                  ? 'bg-indigo-600 text-white self-end shadow-lg shadow-indigo-100' 
                  : 'bg-white text-slate-800 self-start border border-slate-100 shadow-sm'
                }`}
              >
                <p className="text-sm font-medium leading-relaxed">{m.text}</p>
                <div className={`text-[8px] font-bold uppercase tracking-widest mt-2 opacity-50 ${m.sender === 'user' ? 'text-right' : 'text-left'}`}>
                  {m.sender === 'user' ? 'You' : 'VoxAssist'} • {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {isLoading && (
            <div className="flex items-center gap-3 bg-white w-fit px-6 py-3 rounded-full border border-slate-100 shadow-sm">
              <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Thinking</span>
            </div>
          )}
        </div>

        {/* Complaint Drafting Media Support */}
        {complaintDraft && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-indigo-50/50 border border-indigo-100 p-6 rounded-[2.5rem] space-y-4"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-indigo-600 uppercase tracking-widest">Attach Media (Optional)</p>
              <button 
                onClick={() => mediaInputRef.current?.click()}
                disabled={isUploadingMedia}
                className="flex items-center gap-2 px-4 py-2 bg-white text-indigo-600 rounded-xl text-[10px] font-bold uppercase tracking-widest shadow-sm hover:bg-white/80"
              >
                {isUploadingMedia ? <Loader2 className="animate-spin" size={14} /> : <Upload size={14} />} 
                Add Files
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
                  <div key={i} className="w-12 h-12 rounded-xl bg-white border border-indigo-100 overflow-hidden relative group">
                    <img src={url} className="w-full h-full object-cover" />
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
            <p className="text-[10px] text-slate-400 font-medium">
              Say "Yes" or "Okay" to submit with your audio recording.
            </p>
          </motion.div>
        )}

        {/* Identity Alert */}
        {!profile.name && (
          <div className="bg-amber-50 p-4 rounded-3xl border border-amber-100 flex items-center gap-3">
            <AlertCircle size={20} className="text-amber-600 shrink-0" />
            <p className="text-xs text-amber-800 font-medium leading-tight">
              Please tap the profile icon above to set your name and phone for better assistance.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}
