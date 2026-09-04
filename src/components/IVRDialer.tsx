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
  const greetingCancelRef = useRef<boolean>(false);
  const processingSpeechRef = useRef<boolean>(false);

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
  };

  // Reset and start 20s silence timer when IVR finishes speaking
  const startSilenceWatch = () => {
    clearSilenceTimers();
    if (!callActive || isRecordingNote) return;

    silence20TimerRef.current = setTimeout(() => {
      handleSilenceWarning();
    }, 20000); // 20 seconds of silence
  };

  // 20s silence fired: speak warning "We can't hear you", then start 10s final timer
  const handleSilenceWarning = () => {
    clearSilenceTimers();

    let warningText = "Say again.";
    if (language === 'kn-IN') {
      warningText = "ಮತ್ತೆ ಹೇಳಿ.";
    } else if (language === 'hi-IN') {
      warningText = "फिर से बोलें।";
    }

    speakIVR(warningText, undefined, language, () => {
      // Once warning finishes speaking, start 10s countdown
      silence10TimerRef.current = setTimeout(() => {
        handleSilenceGoodbye();
      }, 10000); // 10 seconds after warning
    });
  };

  // 10s silence fired after warning: speak goodbye and end call
  const handleSilenceGoodbye = () => {
    clearSilenceTimers();

    let goodbyeText = "Bye.";
    if (language === 'kn-IN') {
      goodbyeText = "ಬೈ.";
    } else if (language === 'hi-IN') {
      goodbyeText = "बाय।";
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
      window.speechSynthesis.cancel();
    }
    setIsIvrSpeaking(false);
  };

  // Interruption Handler: Stop IVR Speaking when user interrupts or hangs up
  const interruptSpeaking = () => {
    greetingCancelRef.current = true;
    stopSpeechOnly();
  };

  // Play speech using Sarvam TTS with fallback (always emoji-free)
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

    setIsIvrSpeaking(true);
    setStatusMessage(text);

    const handleSpeechEnd = () => {
      setIsIvrSpeaking(false);
      startUserListening();
      if (onFinish) {
        onFinish();
      } else {
        startSilenceWatch();
      }
    };

    // Priority 1: Audio URL from Sarvam
    if (audioUrl) {
      try {
        if (!audioPlayerRef.current) {
          audioPlayerRef.current = new Audio();
        }
        audioPlayerRef.current.src = audioUrl;
        audioPlayerRef.current.onended = handleSpeechEnd;
        audioPlayerRef.current.onerror = () => {
          fallbackSpeech(cleanPrompt, targetLang, handleSpeechEnd);
        };
        await audioPlayerRef.current.play();
        return;
      } catch (err) {
        console.warn("Sarvam audio playback failed:", err);
      }
    }

    // Priority 2: In-browser speech synthesis
    fallbackSpeech(cleanPrompt, targetLang, handleSpeechEnd);
  };

  const fallbackSpeech = (text: string, targetLang: string, onEnd: () => void) => {
    if (!('speechSynthesis' in window)) {
      onEnd();
      return;
    }

    window.speechSynthesis.cancel();
    const cleanText = stripEmojis(text);
    if (!cleanText) {
      onEnd();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = targetLang;
    utterance.rate = 0.95;
    utterance.pitch = 1.05;

    const voices = window.speechSynthesis.getVoices();
    const prefix = targetLang.slice(0, 2).toLowerCase();
    const voiceMatch = voices.find(v => 
      v.lang.toLowerCase().replace('_', '-').startsWith(prefix) && 
      (v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('zira') || v.name.toLowerCase().includes('google') || v.name.toLowerCase().includes('natural'))
    ) || voices.find(v => v.lang.toLowerCase().replace('_', '-').startsWith(prefix));

    if (voiceMatch) utterance.voice = voiceMatch;

    utterance.onend = onEnd;
    utterance.onerror = onEnd;

    window.speechSynthesis.speak(utterance);
  };

  // Start continuous listening for caller voice
  const startUserListening = () => {
    if (!callActive || isRecordingNote) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    processingSpeechRef.current = false;

    try {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.abort();
        } catch {}
      }

      const recognition = new SpeechRecognition();
      // Keep continuous as false to naturally detect sentence pauses, but auto-restart on onend
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = language;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        const spoken = event.results[0][0]?.transcript?.trim();
        if (spoken) {
          clearSilenceTimers();
          processingSpeechRef.current = true;
          try {
            recognition.abort();
          } catch {}
          setIsListening(false);
          handleCallerSpeech(spoken);
        }
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
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

  // Play Language Prompts 1, 2, 3 in Their Own Respective Languages
  const playTrilingualGreeting = async () => {
    greetingCancelRef.current = false;
    clearSilenceTimers();

    const options = [
      { text: "ನಮಸ್ಕಾರ, ವೋಕ್ಸ್-ಅಸಿಸ್ಟ್ ಗ್ರಾಹಕ ಸಹಾಯವಾಣಿಗೆ ತಮಗೆ ಆದರದ ಸ್ವಾಗತ. ಕನ್ನಡಕ್ಕಾಗಿ 1 ಒತ್ತಿ.", lang: "kn-IN" },
      { text: "हिंदी के लिए 2 दबाएँ।", lang: "hi-IN" },
      { text: "For English, press 3.", lang: "en-IN" }
    ];

    // Pre-fetch all 3 audio options in parallel to eliminate inter-phrase latency
    const audioFetchPromises = options.map(async (opt) => {
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: stripEmojis(opt.text), language: opt.lang })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.audioBase64) {
            return `data:audio/wav;base64,${data.audioBase64}`;
          }
        }
      } catch (e) {
        console.warn("Greeting TTS fetch warning:", e);
      }
      return "";
    });

    const audioUrls = await Promise.all(audioFetchPromises);

    for (let i = 0; i < options.length; i++) {
      if (greetingCancelRef.current) break;
      const opt = options[i];
      const audioUrl = audioUrls[i];

      await new Promise<void>((resolve) => {
        speakIVR(opt.text, audioUrl, opt.lang, () => {
          resolve();
        });
      });

      // Brief 250ms cadence between language options
      if (i < options.length - 1 && !greetingCancelRef.current) {
        await new Promise((r) => setTimeout(r, 250));
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
  const sendIVRInput = async ({ digits, message }: { digits?: string; message?: string }) => {
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
          collectedData
        })
      });

      const data = await response.json();
      if (!data) return;

      if (data.language && data.language !== language) {
        setLanguage(data.language);
      }
      if (data.collectedData) {
        setCollectedData(data.collectedData);
      }
      if (data.nextStep) {
        setIvrStep(data.nextStep);
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

      // Normal prompt speaking
      if (data.text) {
        speakIVR(data.text, data.audioUrl, data.language || language);
      }
    } catch (err) {
      console.error("IVR interaction failed:", err);
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

  // Upload Voice Note to Cloudinary as MP3 and attach to complaint
  const uploadVoiceNote = async (audioBlob: Blob) => {
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'voice_note.webm');

      const res = await fetch('/api/upload-audio', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();

      if (data.url) {
        setAudioNoteUrl(data.url);
        const updated = { ...collectedData, audioNoteUrl: data.url };
        setCollectedData(updated);

        sendIVRInput({
          message: "Voice note recorded and attached.",
          digits: undefined
        });
      }
    } catch (err) {
      console.error("Voice note upload failed:", err);
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
      <div className="w-full max-w-xs my-2 text-center">
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
