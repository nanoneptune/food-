import React, { useState, useEffect, useRef } from 'react';
import { 
  Phone, 
  PhoneOff, 
  Mic, 
  Volume2, 
  VolumeX, 
  ArrowLeft,
  RotateCcw
} from 'lucide-react';
import { UserProfile } from '../types';
import { Link } from 'react-router-dom';
import { stripEmojis } from '../utils/text';

interface IVRDialerProps {
  profile?: UserProfile;
}

// DTMF Frequencies for authentic telephone tones
const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
};

export const IVRDialer: React.FC<IVRDialerProps> = ({ profile }) => {
  // Call States
  const [callActive, setCallActive] = useState<boolean>(false);
  const [callDuration, setCallDuration] = useState<number>(0);

  // IVR Dialogue State
  const [ivrStep, setIvrStep] = useState<string>('welcome');
  const [language, setLanguage] = useState<'kn-IN' | 'hi-IN' | 'en-IN'>('en-IN');
  const [isIvrSpeaking, setIsIvrSpeaking] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Press Start Call to begin');
  const [lastCallerSpoken, setLastCallerSpoken] = useState<string>('');
  const [lastIvrResponse, setLastIvrResponse] = useState<string>('');

  // Voice Note Recording (Press 7 Feature)
  const [isBeepPlaying, setIsBeepPlaying] = useState<boolean>(false);
  const [isRecordingNote, setIsRecordingNote] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [audioNoteUrl, setAudioNoteUrl] = useState<string>('');

  // Extracted Complaint Data
  const [collectedData, setCollectedData] = useState<{
    cause?: string;
    location?: string;
    item?: string;
    audioNoteUrl?: string;
  }>({});

  // Audio & WebRTC Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const speechRecognitionRef = useRef<any>(null);
  const callTimerRef = useRef<any>(null);
  const noteTimerRef = useRef<any>(null);

  // Silence / Inactivity Timers (20s first warning, then 10s goodbye)
  const silence20TimerRef = useRef<any>(null);
  const silence10TimerRef = useRef<any>(null);
  const speechSilenceTimerRef = useRef<any>(null);
  const greetingCancelRef = useRef<boolean>(false);
  const processingSpeechRef = useRef<boolean>(false);

  // CRITICAL: the language the IVR is ACTUALLY using right now. Speech
  // recognition and TTS must read this ref (not the React state) because after
  // the caller presses 1, listening is started from an older render closure —
  // reading stale state was why the IVR kept listening/answering in English
  // after the caller had already chosen Kannada.
  const langRef = useRef<string>('en-IN');
  // Per-call conversation memory passed to the server so nothing is re-asked.
  const turnHistoryRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);

  // Web Audio Context initialization
  const getAudioContext = () => {
    if (!audioCtxRef.current) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        audioCtxRef.current = new AudioCtx();
      }
    }
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  };

  // Play realistic DTMF Tone
  const playDTMFTone = (digit: string) => {
    try {
      const ctx = getAudioContext();
      if (!ctx || !DTMF_FREQS[digit]) return;

      const [freq1, freq2] = DTMF_FREQS[digit];
      const now = ctx.currentTime;
      const duration = 0.12;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.frequency.value = freq1;
      osc2.frequency.value = freq2;

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + duration);
      osc2.stop(now + duration);
    } catch (e) {
      console.warn("DTMF tone error:", e);
    }
  };

  // Play authentic Telephone Beep Tone (Press 7 trigger)
  const playBeepSound = (): Promise<void> => {
    return new Promise((resolve) => {
      try {
        const ctx = getAudioContext();
        if (!ctx) {
          resolve();
          return;
        }

        setIsBeepPlaying(true);
        const now = ctx.currentTime;
        const duration = 0.45;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, now);

        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + duration);

        setTimeout(() => {
          setIsBeepPlaying(false);
          resolve();
        }, duration * 1000);
      } catch (e) {
        setIsBeepPlaying(false);
        resolve();
      }
    });
  };

  // Clear all silence timers
  const clearSilenceTimers = () => {
    if (silence20TimerRef.current) {
      clearTimeout(silence20TimerRef.current);
      silence20TimerRef.current = null;
    }
    if (silence10TimerRef.current) {
      clearTimeout(silence10TimerRef.current);
      silence10TimerRef.current = null;
    }
    if (speechSilenceTimerRef.current) {
      clearTimeout(speechSilenceTimerRef.current);
      speechSilenceTimerRef.current = null;
    }
  };

  // Reset and start silence watch when IVR finishes speaking (45s duration)
  const startSilenceWatch = () => {
    clearSilenceTimers();
    if (!callActive || isRecordingNote) return;

    silence20TimerRef.current = setTimeout(() => {
      handleSilenceWarning();
    }, 45000); // Generous 45 seconds before polite nudge
  };

  // 45s silence fired: speak warning in current language, then start 20s final timer
  const handleSilenceWarning = () => {
    clearSilenceTimers();

    let warningText = "We could not hear your voice clearly. Please speak again.";
    if (language === 'kn-IN') {
      warningText = "ತಾವು ಹೇಳುವುದು ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸುತ್ತಿಲ್ಲ, ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ತಿಳಿಸಿ.";
    } else if (language === 'hi-IN') {
      warningText = "आपकी आवाज़ स्पष्ट नहीं आ रही है, कृपया फिर से बोलें।";
    }

    speakIVR(warningText, undefined, language, () => {
      // Once warning finishes speaking, start 20s countdown before gentle signoff
      silence10TimerRef.current = setTimeout(() => {
        handleSilenceGoodbye();
      }, 20000);
    });
  };

  // Silence final timeout: speak goodbye and end call
  const handleSilenceGoodbye = () => {
    clearSilenceTimers();

    let goodbyeText = "Thank you for calling the Food Safety Helpline. Goodbye!";
    if (language === 'kn-IN') {
      goodbyeText = "ಧನ್ಯವಾದಗಳು, ಆಹಾರ ಸುರಕ್ಷತಾ ಸಹಾಯವಾಣಿಗೆ ಕರೆ ಮಾಡಿದ್ದಕ್ಕಾಗಿ ವಂದನೆಗಳು. ಬೈ!";
    } else if (language === 'hi-IN') {
      goodbyeText = "खाद्य सुरक्षा हेल्पलाइन में संपर्क करने के लिए धन्यवाद। बाय!";
    }

    speakIVR(goodbyeText, undefined, language, () => {
      endCall();
    });
  };

  // Internal audio/speech stopper without setting greeting cancellation flag
  const stopSpeechOnly = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
    }
    if (window.speechSynthesis) {
      // Cancel any leftover speech (no browser voice is used for speaking).
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    setIsIvrSpeaking(false);
  };

  // Interruption Handler: Stop IVR Speaking when user interrupts or hangs up
  const interruptSpeaking = () => {
    greetingCancelRef.current = true;
    stopSpeechOnly();
  };

  // Play speech: SERVER neural TTS only (/api/tts, Sarvam). The browser's
  // built-in speechSynthesis voice is deliberately NOT used for speaking.
  const speakIVR = async (
    text: string, 
    audioUrl?: string, 
    targetLang: string = language,
    onFinish?: () => void
  ) => {
    stopSpeechOnly();
    clearSilenceTimers();
    const cleanPrompt = stripEmojis(text);
    if (!cleanPrompt) {
      if (onFinish) onFinish();
      return;
    }

    // Sync the live language BEFORE speaking/restarting recognition so the
    // follow-up listening session uses the language just selected.
    langRef.current = targetLang;

    setIsIvrSpeaking(true);
    setStatusMessage(text);
    setLastIvrResponse(text);

    const handleSpeechEnd = () => {
      setIsIvrSpeaking(false);
      if (onFinish) {
        // Explicit follow-up action (record beep / end call after submit):
        // do NOT open the mic afterwards.
        onFinish();
      } else {
        startUserListening();
        startSilenceWatch();
      }
    };

    // 1ST PRIORITY: Pre-generated / server audio URL (fast playback)
    if (audioUrl) {
      try {
        if (!audioPlayerRef.current) {
          audioPlayerRef.current = new Audio();
        }
        audioPlayerRef.current.src = audioUrl;
        try { audioPlayerRef.current.playbackRate = 1.4; } catch {} // quick 1.4x speech
        audioPlayerRef.current.onended = handleSpeechEnd;
        audioPlayerRef.current.onerror = () => {
          fallbackSpeech(cleanPrompt, targetLang, handleSpeechEnd);
        };
        await audioPlayerRef.current.play();
        return;
      } catch (err) {
        console.warn("Audio URL playback notice:", err);
      }
    }

    // 2ND PRIORITY: High-fidelity server neural TTS (/api/tts — Edge free/Sarvam)
    fallbackSpeech(cleanPrompt, targetLang, handleSpeechEnd);
  };

  const fallbackSpeech = async (text: string, targetLang: string, onEnd: () => void) => {
    const cleanText = stripEmojis(text);
    if (!cleanText) {
      onEnd();
      return;
    }

    const prefix = targetLang.slice(0, 2).toLowerCase();

    // High-fidelity server neural TTS (/api/tts — free Edge voices / Sarvam)
    try {
      let langName = "English";
      if (prefix === "kn") langName = "Kannada";
      else if (prefix === "hi") langName = "Hindi";

      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanText, language: langName })
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.audioBase64) {
          if (!audioPlayerRef.current) {
            audioPlayerRef.current = new Audio();
          }
          // mp3 (Edge free TTS) or wav (Sarvam) — pick the correct MIME.
          const mime = data.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
          audioPlayerRef.current.src = `data:${mime};base64,${data.audioBase64}`;
          try { audioPlayerRef.current.playbackRate = 1.4; } catch {} // quick 1.4x speech
          audioPlayerRef.current.onended = () => onEnd();
          audioPlayerRef.current.onerror = () => onEnd();
          await audioPlayerRef.current.play();
          return;
        }
      }
    } catch (apiErr) {
      console.warn("Fallback /api/tts request notice:", apiErr);
    }

    // Final safety fallback
    onEnd();
  };

  // Start continuous listening for caller voice (Google Browser Web Speech API 1st Priority)
  const startUserListening = () => {
    if (!callActive || isRecordingNote) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    processingSpeechRef.current = false;
    let localCapturedSpoken = '';

    try {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.abort();
        } catch {}
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      // Use the LIVE language ref — after pressing 1 the closure may still hold
      // the pre-press 'en-IN', which made Kannada speech get recognized as English.
      recognition.lang = langRef.current;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        clearSilenceTimers();

        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        const rawSpoken = (finalTranscript + interimTranscript).trim();
        const cleanSpoken = rawSpoken
          .replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1')
          .replace(/([\u0900-\u0D7F]+)(?:\s+\1)+/gu, '$1')
          .trim();

        if (cleanSpoken) {
          localCapturedSpoken = cleanSpoken;
          setLastCallerSpoken(cleanSpoken);
          
          // Wait for a short 1.5s silence before concluding the user has
          // finished speaking — quick enough that replies feel instant.
          if (speechSilenceTimerRef.current) {
            clearTimeout(speechSilenceTimerRef.current);
          }
          speechSilenceTimerRef.current = setTimeout(() => {
            if (isListening && !processingSpeechRef.current && localCapturedSpoken) {
              clearSilenceTimers();
              processingSpeechRef.current = true;
              const speechToProcess = localCapturedSpoken;
              localCapturedSpoken = '';
              try {
                recognition.abort();
              } catch {}
              setIsListening(false);
              handleCallerSpeech(speechToProcess);
            }
          }, 1500);
        }
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);

        // CRITICAL FIX: If user spoke but browser closed recognition stream before marking isFinal=true, process it NOW!
        if (localCapturedSpoken && localCapturedSpoken.trim() && !processingSpeechRef.current) {
          processingSpeechRef.current = true;
          const speechToProcess = localCapturedSpoken.trim();
          localCapturedSpoken = '';
          clearSilenceTimers();
          handleCallerSpeech(speechToProcess);
          return;
        }

        // Robust Auto-restart if we didn't get any result and we are still in listening mode
        if (callActive && !isIvrSpeaking && !isRecordingNote && !greetingCancelRef.current && !processingSpeechRef.current) {
          setTimeout(() => {
            if (callActive && !isIvrSpeaking && !isRecordingNote && !greetingCancelRef.current && !processingSpeechRef.current) {
              try {
                recognition.start();
              } catch (e) {}
            }
          }, 350);
        }
      };

      speechRecognitionRef.current = recognition;
      recognition.start();
    } catch (e) {
      console.warn("Speech recognition start warning:", e);
    }
  };

  // Play Language Prompts 1, 2, 3 instantly at 1.4X speed
  const playTrilingualGreeting = async () => {
    greetingCancelRef.current = false;
    clearSilenceTimers();

    // Only the FIRST line (Kannada) carries the welcome; 2 and 3 are short instructions
    const options = [
      { text: "ನಮಸ್ಕಾರ! ಆಹಾರ ಸುರಕ್ಷತಾ ಮತ್ತು ನೈರ್ಮಲ್ಯ ಪರಿಶೀಲನೆ ಸಹಾಯವಾಣಿಗೆ ಸ್ವಾಗತ. ಕನ್ನಡಕ್ಕಾಗಿ 1 ಒತ್ತಿ.", lang: "kn-IN" },
      { text: "हिंदी के लिए 2 दबाएँ।", lang: "hi-IN" },
      { text: "For English, press 3.", lang: "en-IN" }
    ];

    for (let i = 0; i < options.length; i++) {
      if (greetingCancelRef.current) break;
      const opt = options[i];

      await new Promise<void>((resolve) => {
        speakIVR(opt.text, undefined, opt.lang, () => {
          resolve();
        });
      });

      // Brief 200ms cadence between language options
      if (i < options.length - 1 && !greetingCancelRef.current) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (!greetingCancelRef.current) {
      startSilenceWatch();
    }
  };

  // Start Call Flow
  const startCall = async () => {
    getAudioContext();
    clearSilenceTimers();
    turnHistoryRef.current = [];
    langRef.current = 'en-IN';
    setCallActive(true);
    setCallDuration(0);
    setIvrStep('welcome');
    setCollectedData({});
    setAudioNoteUrl('');

    // Timer
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    callTimerRef.current = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);

    // Play 1 in Kannada, 2 in Hindi, 3 in English
    playTrilingualGreeting();
  };

  // Hang Up Call
  const endCall = () => {
    greetingCancelRef.current = true;
    interruptSpeaking();
    clearSilenceTimers();
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.abort();
    }
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
    }
    if (noteTimerRef.current) {
      clearInterval(noteTimerRef.current);
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setCallActive(false);
    setIsListening(false);
    setIsRecordingNote(false);
    setStatusMessage('Call Ended');
  };

  // Handle DTMF Dialpad Press
  const handleKeypadPress = async (digit: string) => {
    greetingCancelRef.current = true;
    playDTMFTone(digit);
    interruptSpeaking();
    clearSilenceTimers();

    sendIVRInput({ digits: digit });
  };

  // Handle Caller Speech
  const handleCallerSpeech = (text: string) => {
    if (!text || !text.trim()) return;
    clearSilenceTimers();
    sendIVRInput({ message: text });
  };

  // Central IVR State Transition Caller
  const sendIVRInput = async ({ 
    digits, 
    message, 
    audioNoteUrl: inputAudioUrl, 
    isVoiceNote 
  }: { 
    digits?: string; 
    message?: string; 
    audioNoteUrl?: string; 
    isVoiceNote?: boolean; 
  }) => {
    clearSilenceTimers();
    setStatusMessage('AI is analyzing complaint...');

    // Remember what the caller said/pressed (conversation memory) so the server
    // never re-asks an already-answered question.
    if (message && message.trim()) {
      turnHistoryRef.current.push({ role: 'user', content: message.trim() });
    } else if (digits) {
      turnHistoryRef.current.push({ role: 'user', content: `Pressed key ${digits}` });
    }
    if (turnHistoryRef.current.length > 40) {
      turnHistoryRef.current = turnHistoryRef.current.slice(-30);
    }

    try {
      const response = await fetch('/api/ivr/dialogue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          digits,
          step: ivrStep,
          language,
          profile,
          collectedData,
          audioNoteUrl: inputAudioUrl,
          isVoiceNote,
          history: turnHistoryRef.current.slice(-12)
        })
      });

      const data = await response.json();
      setStatusMessage('Connected');
      if (!data) return;

      if (data.language && data.language !== language) {
        setLanguage(data.language);
        langRef.current = data.language; // sync immediately (no stale closure)
      }
      if (data.collectedData) {
        setCollectedData(data.collectedData);
      }
      if (data.nextStep) {
        setIvrStep(data.nextStep);
      }

      // Record the IVR reply into the conversation memory.
      if (data.text) {
        turnHistoryRef.current.push({ role: 'assistant', content: data.text });
      }

      // Handle Press 7 Flow (Voice Note Recording)
      if (data.nextStep === 'ready_for_beep' || digits === '7') {
        await speakIVR(data.text, data.audioUrl, data.language || language, async () => {
          setTimeout(async () => {
            await playBeepSound();
            startVoiceNoteRecording();
          }, 200);
        });
        return;
      }

      // Normal prompt speaking; when the complaint was submitted, end the call
      // automatically after the confirmation is read out.
      if (data.text) {
        const onFinish = data.nextStep === 'submitted' && data.isComplaintReady
          ? () => endCall()
          : undefined;
        speakIVR(data.text, data.audioUrl, data.language || language, onFinish);
      }
    } catch (err) {
      console.error("IVR interaction failed:", err);
      setStatusMessage('Connected');
    }
  };

  // Start High-Fidelity Recording for Voice Note (Press 7)
  const startVoiceNoteRecording = async () => {
    try {
      clearSilenceTimers();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach((t) => t.stop());
        await uploadVoiceNote(audioBlob);
      };

      mediaRecorder.start(250);
      setIsRecordingNote(true);
      setRecordingSeconds(0);

      if (noteTimerRef.current) clearInterval(noteTimerRef.current);
      noteTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Could not access microphone for voice note:", err);
    }
  };

  // Stop Recording Voice Note
  const stopVoiceNoteRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (noteTimerRef.current) clearInterval(noteTimerRef.current);
    setIsRecordingNote(false);
  };

  // Transcribe recorded voice with STT, upload audio file, and react properly in IVR
  const uploadVoiceNote = async (audioBlob: Blob) => {
    try {
      setStatusMessage('Processing your recorded voice note...');

      // 1. Transcribe the recorded voice with STT so IVR understands what was spoken
      let transcript = '';
      try {
        const sttForm = new FormData();
        sttForm.append('audio', audioBlob, 'recording.webm');
        const langName = language === 'kn-IN' ? 'Kannada' : (language === 'hi-IN' ? 'Hindi' : 'English');
        sttForm.append('language', langName);

        const sttRes = await fetch('/api/stt', { method: 'POST', body: sttForm });
        if (sttRes.ok) {
          const sttData = await sttRes.json();
          transcript = sttData.transcript?.trim() || '';
        }
      } catch (sttErr) {
        console.warn("STT on recorded voice note notice:", sttErr);
      }

      // 2. Upload to Cloudinary for permanent MP3 audio evidence link
      let uploadedUrl = '';
      try {
        const uploadForm = new FormData();
        uploadForm.append('audio', audioBlob, 'voice_note.webm');
        const uploadRes = await fetch('/api/upload-audio', { method: 'POST', body: uploadForm });
        if (uploadRes.ok) {
          const uploadData = await uploadRes.json();
          uploadedUrl = uploadData.url || '';
        }
      } catch (upErr) {
        console.warn("Upload audio notice:", upErr);
      }

      if (transcript) {
        setLastCallerSpoken(transcript);
      }
      if (uploadedUrl) {
        setAudioNoteUrl(uploadedUrl);
      }

      const updated = { 
        ...collectedData, 
        audioNoteUrl: uploadedUrl || collectedData.audioNoteUrl,
        cause: transcript || collectedData.cause
      };
      setCollectedData(updated);

      // React properly to what the caller said in their voice note!
      sendIVRInput({
        message: transcript || "Voice note recorded and attached.",
        audioNoteUrl: uploadedUrl,
        isVoiceNote: true
      });
    } catch (err) {
      console.error("Voice note handling error:", err);
      sendIVRInput({
        message: "Voice note recorded.",
        isVoiceNote: true
      });
    }
  };

  // Format seconds to mm:ss
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      endCall();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  // Keep the live language ref in sync with the React state at all times.
  useEffect(() => {
    langRef.current = language;
  }, [language]);

  return (
    <div className="max-w-md mx-auto px-4 py-2 flex flex-col items-center justify-between min-h-[calc(100vh-6rem)]">
      {/* Top Floating Back Button */}
      <div className="w-full flex items-center justify-between pt-1 pb-2">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-white/20 hover:bg-white/30 backdrop-blur-xl border border-white/30 px-3.5 py-1.5 rounded-full shadow-md transition-all active:scale-95"
        >
          <ArrowLeft size={14} /> Back
        </Link>
        {callActive && (
          <div className="flex items-center gap-2 px-3 py-1 bg-white/20 backdrop-blur-xl border border-white/30 rounded-full text-white text-xs font-bold shadow-md">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
            <span>{formatTime(callDuration)}</span>
          </div>
        )}
      </div>

      {/* Huge Header: HELPLINE */}
      <div className="pt-2 pb-2 text-center select-none">
        <h1 className="font-brand-display text-6xl sm:text-7xl md:text-8xl tracking-tighter text-white drop-shadow-md transform -skew-x-6 leading-none inline-block">
          HELPLINE
        </h1>
        <p className="text-white/80 font-bold text-xs tracking-wider uppercase mt-1 drop-shadow-sm">
          Toll-Free 1800-FOOD-VOX
        </p>
      </div>

      {/* Transparent Glass Status Pill */}
      <div className="w-full max-w-xs my-1 text-center">
        <div className="bg-white/15 backdrop-blur-2xl border border-white/25 rounded-2xl px-4 py-2.5 shadow-lg text-white">
          {isBeepPlaying ? (
            <div className="text-amber-300 font-bold text-xs flex items-center justify-center gap-1.5">
              <span>🔔</span> Beep Tone Playing...
            </div>
          ) : isRecordingNote ? (
            <div className="text-rose-300 font-bold text-xs flex items-center justify-center gap-1.5 animate-pulse">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-400" />
              Recording Voice Note ({formatTime(recordingSeconds)}) — Press # to Stop
            </div>
          ) : isIvrSpeaking ? (
            <div className="text-white font-medium text-xs flex items-center justify-center gap-1.5">
              <Volume2 size={15} className="animate-pulse text-white/90 shrink-0" />
              <span className="truncate">Speaking... Tap any key to interrupt</span>
            </div>
          ) : isListening ? (
            <div className="text-emerald-300 font-medium text-xs flex items-center justify-center gap-1.5">
              <Mic size={15} className="animate-pulse shrink-0" />
              <span>Listening to your voice...</span>
            </div>
          ) : (
            <div className="text-white/80 text-xs font-medium truncate">
              {callActive ? 'Awaiting keypad press or speech' : 'Press Start Call below'}
            </div>
          )}
        </div>
      </div>

      {/* Live Conversation Transcript Card: Displays caller speech and IVR reaction */}
      {callActive && (lastIvrResponse || lastCallerSpoken) && (
        <div className="w-full max-w-xs my-1.5 bg-black/30 backdrop-blur-xl border border-white/20 rounded-2xl p-3 shadow-lg text-left space-y-1.5 transition-all text-xs">
          {lastIvrResponse && (
            <div className="text-white/95 flex items-start gap-1.5">
              <span className="shrink-0 text-amber-300 font-black">🤖 IVR:</span>
              <span className="line-clamp-2 leading-relaxed">{lastIvrResponse}</span>
            </div>
          )}
          {lastCallerSpoken && (
            <div className="text-emerald-300 flex items-start gap-1.5 font-medium">
              <span className="shrink-0 text-emerald-400 font-black">🎙️ You:</span>
              <span className="line-clamp-2 leading-relaxed">"{lastCallerSpoken}"</span>
            </div>
          )}
        </div>
      )}

      {/* Dialpad: Independent, NO background, NO border on container, Glassmorphism Transparent Buttons */}
      <div className="w-full max-w-xs my-3">
        <div className="grid grid-cols-3 gap-3">
          {[
            { digit: '1', sub: 'ಕನ್ನಡ' },
            { digit: '2', sub: 'हिंदी' },
            { digit: '3', sub: 'English' },
            { digit: '4', sub: 'GHI' },
            { digit: '5', sub: 'JKL' },
            { digit: '6', sub: 'MNO' },
            { digit: '7', sub: '🎙️ Voice' },
            { digit: '8', sub: 'TUV' },
            { digit: '9', sub: 'Submit' },
            { digit: '*', sub: 'Clear' },
            { digit: '0', sub: '+' },
            { digit: '#', sub: 'Stop' },
          ].map(({ digit, sub }) => (
            <button
              key={digit}
              disabled={!callActive}
              onClick={() => {
                if (digit === '#' && isRecordingNote) {
                  stopVoiceNoteRecording();
                } else {
                  handleKeypadPress(digit);
                }
              }}
              className={`flex flex-col items-center justify-center h-16 sm:h-18 rounded-2xl transition-all select-none active:scale-95 cursor-pointer backdrop-blur-xl ${
                !callActive
                  ? 'bg-white/10 hover:bg-white/15 border border-white/15 text-white/50 cursor-not-allowed'
                  : digit === '7'
                  ? 'bg-white/25 hover:bg-white/35 border border-white/40 text-white shadow-lg ring-1 ring-white/30'
                  : 'bg-white/15 hover:bg-white/25 border border-white/20 text-white shadow-lg hover:shadow-xl'
              }`}
            >
              <span className="text-2xl font-black tracking-tight leading-none drop-shadow-sm">{digit}</span>
              <span className="text-[10px] text-white/80 tracking-wider uppercase font-bold mt-1 drop-shadow-xs">
                {sub}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Call Action Controls */}
      <div className="w-full max-w-xs flex items-center justify-center gap-3 pt-2 pb-4">
        {callActive ? (
          <>
            {/* Interrupt Speech Button */}
            <button
              onClick={interruptSpeaking}
              title="Mute / Stop IVR voice"
              className="p-3.5 rounded-2xl bg-white/20 hover:bg-white/30 text-white border border-white/30 backdrop-blur-xl shadow-lg transition-all active:scale-95"
            >
              <VolumeX size={18} />
            </button>

            {/* Red Glass End Call Button */}
            <button
              onClick={endCall}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-rose-600/90 hover:bg-rose-600 text-white font-bold text-sm shadow-xl shadow-rose-950/40 border border-white/30 backdrop-blur-xl transition-all active:scale-95 cursor-pointer"
            >
              <PhoneOff size={18} />
              <span>End Call</span>
            </button>

            {/* Record Toggle Button (7 or #) */}
            {isRecordingNote ? (
              <button
                onClick={stopVoiceNoteRecording}
                className="px-4 py-3.5 rounded-2xl bg-amber-500/90 hover:bg-amber-500 text-slate-950 font-bold text-xs backdrop-blur-xl shadow-lg border border-white/30 transition-all active:scale-95"
              >
                Stop (#)
              </button>
            ) : (
              <button
                onClick={() => handleKeypadPress('7')}
                className="px-4 py-3.5 rounded-2xl bg-white/20 hover:bg-white/30 text-white font-bold text-xs backdrop-blur-xl shadow-lg border border-white/30 transition-all active:scale-95"
              >
                Record (7)
              </button>
            )}
          </>
        ) : (
          <button
            onClick={startCall}
            className="w-full flex items-center justify-center gap-2.5 py-4 rounded-2xl bg-white/25 hover:bg-white/35 text-white font-black text-base shadow-xl shadow-black/15 border border-white/40 backdrop-blur-2xl transition-all active:scale-95 cursor-pointer"
          >
            <Phone size={20} className="fill-white" />
            <span>Start Helpline Call</span>
          </button>
        )}
      </div>
    </div>
  );
};
