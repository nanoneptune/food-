import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Mic, MicOff, Send, AlertCircle, Loader2, Languages, Utensils, Upload, X, Volume2, VolumeX, Sparkles, ChevronDown, ChevronUp, Cpu, PhoneCall } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { VoiceInteraction, UserProfile } from '../types';
import ParticleBall from './ParticleBall';
import { RenderedMarkdown } from './RenderedMarkdown';
import { transcribeAudioInBrowser } from '../lib/clientWhisper';
import { stripEmojis, detectTextScript } from '../utils/text';

function isHallucinatedText(text: string): boolean {
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

export default function VoiceAssistant({ profile }: { profile: UserProfile }) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [transcript, setTranscript] = useState('');
  const [manualText, setManualText] = useState('');
  const [messages, setMessages] = useState<VoiceInteraction[]>([]);
  const [language, setLanguage] = useState<'English' | 'Hindi' | 'Kannada'>('English');
  const [isLoading, setIsLoading] = useState(false);
  const [complaintDraft, setComplaintDraft] = useState<{ query: string; markdownReport?: string; media: string[] } | null>(null);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis | null>(typeof window !== 'undefined' ? window.speechSynthesis : null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const transcriptRef = useRef<string>('');
  // Accumulated FINALIZED text for the current listening round (persists across Chrome
  // recognition auto-restarts). final + live interim = what the user actually said.
  const finalTranscriptRef = useRef<string>('');
  const interimTranscriptRef = useRef<string>('');
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const silenceTimerRef = useRef<any>(null);
  const isListeningRef = useRef<boolean>(false);
  const isSpeakingRef = useRef<boolean>(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadIntervalRef = useRef<any>(null);
  const hasSpokenRef = useRef<boolean>(false);
  const lastSoundTimeRef = useRef<number>(0);
  // Counts silent auto-restarts of the browser recognizer (used to stop the mic
  // when only low/quiet sound is present instead of listening forever).
  const silentRestartsRef = useRef<number>(0);
  // When the current listening round started (used to give gentle feedback when
  // the user held the mic but nothing was heard for a while).
  const listenStartRef = useRef<number>(0);
  // Guards against spamming the same "couldn't hear you" prompt repeatedly.
  const lastNoSpeechPromptRef = useRef<number>(0);

  const updateListeningState = (val: boolean) => {
    isListeningRef.current = val;
    setIsListening(val);
  };

  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);

  const updateSpeakingState = (val: boolean) => {
    isSpeakingRef.current = val;
    setIsSpeaking(val);
    if (!val) setPlayingMsgId(null);
  };

  // Chrome re-delivers the last finalized segment every time a continuous recognition
  // session auto-ends and is restarted ("restart echo"), which makes a single word appear
  // many times. This merges an incoming chunk into the accumulated transcript while
  // removing any leading words that are already the trailing words of the base text.
  const appendUniqueTail = (base: string, incoming: string): string => {
    const baseWords = base.trim().split(/\s+/).filter(Boolean);
    const inWords = incoming.trim().split(/\s+/).filter(Boolean);
    if (inWords.length === 0) return base.trim();
    let overlap = 0;
    const maxOverlap = Math.min(baseWords.length, inWords.length);
    for (let len = maxOverlap; len >= 1; len--) {
      if (baseWords.slice(-len).join(' ') === inWords.slice(0, len).join(' ')) {
        overlap = len;
        break;
      }
    }
    if (overlap >= inWords.length) return base.trim();
    return (baseWords.join(' ') + ' ' + inWords.slice(overlap).join(' ')).trim();
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
    setPlayingMsgId(null);
    updateSpeakingState(false);
  };

  // Keep a reference to the browser speech synthesis object purely so it can
  // be CANCELED (no browser voice is ever used for speaking — see speak()).
  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      synthRef.current = window.speechSynthesis;
    }
  }, []);

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

      // AudioContext Voice Activity Detection (VAD) for particle energy & audio tracking
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
          const vadStartedAt = Date.now();
          let lastVoiceAt = 0;
          let vadAutoStopped = false;

          // Amplitude-based Voice Activity Detection (VAD):
          // - Tracks voice energy so the assistant knows the user actually spoke.
          // - STOPS recording automatically when the sound level stays low for a
          //   short while after speech (~1.8s of quiet) or after a max cap, so
          //   silence is never recorded and sent to the STT engine.
          vadIntervalRef.current = setInterval(() => {
            if (!isListeningRef.current || vadAutoStopped) return;
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const average = sum / dataArray.length;

            // Voice-level energy present
            if (average > 10) {
              lastVoiceAt = Date.now();
              hasSpokenRef.current = true;
              lastSoundTimeRef.current = Date.now();
            }

            const quietMs = lastVoiceAt ? (Date.now() - lastVoiceAt) : (Date.now() - vadStartedAt);
            const quietSinceSpeechMs = 1800; // 1.8s of low sound after speech → done
            const maxTotalMs = 20000;        // hard cap: never record silence forever
            const shouldStop =
              (lastVoiceAt > 0 && quietMs > quietSinceSpeechMs) ||
              (!lastVoiceAt && quietMs > maxTotalMs) ||
              (lastVoiceAt > 0 && quietMs > maxTotalMs);

            if (shouldStop && mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
              vadAutoStopped = true;
              if (vadIntervalRef.current) {
                clearInterval(vadIntervalRef.current);
                vadIntervalRef.current = null;
              }
              // Stop, transcribe and send automatically (recorder fallback mode).
              stopListeningAndSend(true);
            }
          }, 120);
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

          // 1. Send recorded audio to high-accuracy server STT (/api/stt: Groq Whisper STT)
          try {
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
          } catch (serverErr) {
            console.warn("Server STT request notice:", serverErr);
          }

          // 2. Client-side fallback: In-browser Transformers.js Whisper
          try {
            const clientText = await transcribeAudioInBrowser(audioBlob, language);
            if (clientText && clientText.trim() && !isHallucinatedText(clientText)) {
              return resolve(clientText.trim());
            }
          } catch (clientErr) {
            console.warn("Client Whisper fallback notice:", clientErr);
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
        try {
          recognitionRef.current.abort();
        } catch {}
      }

      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        // Continuous listening so natural pauses between Kannada / Hindi words do not abort recognition
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        
        // Exact BCP-47 language tag for Google Keyboard / Chrome speech engine
        if (language === 'Hindi') recognition.lang = 'hi-IN';
        else if (language === 'Kannada') recognition.lang = 'kn-IN';
        else recognition.lang = 'en-IN';

        recognition.onstart = () => {
          updateListeningState(true);
          setMicError(null);
        };

        recognition.onresult = (event: any) => {
          // Ignore stray results that arrive after we already stopped listening
          if (!isListeningRef.current) return;

          let interimText = '';
          // Only process results that are NEW since the last event (event.resultIndex onwards).
          // Scanning the whole list from index 0 re-adds already-finalized text on every event,
          // and Chrome re-delivers the previous segment when continuous recognition restarts —
          // both make every word appear multiple times.
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const result = event.results[i];
            const piece = result && result[0] ? (result[0].transcript || '') : '';
            if (result.isFinal) {
              // Append once, dropping any "restart echo" that overlaps the accumulated tail
              finalTranscriptRef.current = appendUniqueTail(finalTranscriptRef.current, piece);
            } else {
              interimText += piece;
            }
          }
          interimTranscriptRef.current = interimText;

          // Visible transcript = finalized text + live interim, echo-free.
          // Only react when the text actually CHANGED — pure restart echoes produce the
          // same string and must not re-arm the silence timer forever.
          const cleanText = appendUniqueTail(finalTranscriptRef.current, interimTranscriptRef.current);

          if (cleanText && cleanText !== transcriptRef.current) {
            transcriptRef.current = cleanText;
            setTranscript(cleanText);
            hasSpokenRef.current = true;
            lastSoundTimeRef.current = Date.now();
            silentRestartsRef.current = 0;

            // User barge-in: If user speaks while AI audio is active, stop AI speech immediately
            if (isSpeakingRef.current || activeAudioRef.current) {
              stopSpeaking();
            }

            // Silence Detection: auto-send after ~1.5s of quiet following real
            // speech — short enough that replies feel instant, long enough that
            // natural mid-sentence pauses are not cut off.
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
            }
            silenceTimerRef.current = setTimeout(() => {
              if (isListeningRef.current && transcriptRef.current.trim()) {
                stopListeningAndSend();
              }
            }, 1500);
          }
        };

        recognition.onerror = (event: any) => {
          console.warn('Browser speech recognition notice:', event.error);
          if (event.error === 'not-allowed') {
            setMicError("Microphone access blocked in browser. Please enable permissions.");
          }
        };

        recognition.onend = () => {
          if (isListeningRef.current) {
            // Chrome abruptly ends recognition when it detects a long pause or no speech.
            // Flush the trailing interim words into the final transcript so the END of the
            // user's sentence is never lost, then restart recognition to keep listening.
            // Auto-send still happens only when the silence timer fires.
            const pendingTail = interimTranscriptRef.current.trim();
            if (pendingTail && !isHallucinatedText(pendingTail)) {
              finalTranscriptRef.current = appendUniqueTail(finalTranscriptRef.current, pendingTail);
              const shownText = finalTranscriptRef.current;
              if (shownText) {
                transcriptRef.current = shownText;
                setTranscript(shownText);
              }
            }
            interimTranscriptRef.current = '';

            // LOW-SOUND WATCHDOG: if recognition keeps ending with no speech at all
            // (quiet background / the user is not talking), stop listening after a
            // few silent restarts instead of looping forever, and prompt politely.
            if (!finalTranscriptRef.current.trim()) {
              silentRestartsRef.current += 1;
              if (silentRestartsRef.current >= 4) {
                stopListeningAndSend(true);
                return;
              }
            }
            try {
              recognition.start();
            } catch {}
          }
        };

        recognitionRef.current = recognition;
      }
    } catch (err) {
      console.warn("Speech recognition initialization error", err);
    }
  }, [language]);

  // Close the microphone quietly (nothing sent, no prompt). Used so the mic
  // and the speaker are NEVER active at the same moment — this also avoids the
  // browser playing its mic "ding" twice from two overlapping sessions.
  const closeMicQuietly = () => {
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
    if (isListeningRef.current) {
      updateListeningState(false);
    }
    try {
      recognitionRef.current?.stop();
    } catch {}
  };

  // Break long replies into short speakable sentences (<= ~700 chars each) so
  // even very long answers are actually spoken instead of failing silently.
  const splitSpeechSegments = (rawText: string): string[] => {
    const cleaned = stripEmojis(rawText).replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];
    if (cleaned.length <= 700) return [cleaned];
    const sentences = cleaned.match(/[^.!?।॥…]+[.!?।॥…]+|[^.!?।॥…]+$/g) || [];
    const segments: string[] = [];
    let current = '';
    for (const sentence of sentences) {
      const candidate = current + sentence;
      if (candidate.length > 700 && current) {
        segments.push(current.trim());
        current = sentence;
      } else {
        current = candidate;
      }
    }
    const tail = current.trim();
    if (tail) segments.push(tail);
    return segments.length > 0 ? segments : [cleaned.slice(0, 700)];
  };

  const speak = async (text: string, audioUrl?: string, messageId?: string, speakLang?: string) => {
    if (!text) return;

    // Toggle Mute: If clicking audio icon of the message that is CURRENTLY PLAYING, mute/stop it immediately!
    if (isSpeaking && messageId && playingMsgId === messageId) {
      stopSpeaking();
      return;
    }

    stopSpeaking();
    if (messageId) setPlayingMsgId(messageId);

    const textToSpeak = stripEmojis(text);
    if (!textToSpeak) return;

    // Speak in the language the USER actually used (explicit override) or the
    // current UI language — never force Kannada text through an English voice.
    const effectiveLang = (speakLang || language) as 'English' | 'Hindi' | 'Kannada';

    // Voice output = SERVER neural TTS only (/api/tts — free Edge voices or
    // Sarvam). The browser's built-in speechSynthesis voice is deliberately
    // NOT used for speaking.
    // 1.4x speaking speed (pitch preserved) — quick, energetic responses.
    const playAudioEl = (audio: HTMLAudioElement) => {
      try { audio.playbackRate = 1.4; } catch {}
      audio.onplay = () => updateSpeakingState(true);
      audio.onended = () => {
        updateSpeakingState(false);
        setPlayingMsgId(null);
      };
      audio.onerror = () => {
        updateSpeakingState(false);
        setPlayingMsgId(null);
      };
      activeAudioRef.current = audio;
      return audio.play();
    };

    // MIC & SPEAKER ARE NEVER OPEN TOGETHER. The assistant's voice starts
    // only after the mic is fully closed (and vice versa in startListening).
    // This also prevents the browser double "ding" caused by two mic sessions.
    closeMicQuietly();

    // Split long replies into short speakable pieces — a huge single request
    // may silently fail, so big answers are spoken segment by segment.
    const segments = splitSpeechSegments(textToSpeak);
    if (segments.length === 0) return;

    // 1ST PRIORITY: Pre-generated audio URL covers a SHORT reply.
    if (audioUrl && segments.length === 1) {
      try {
        const audio = new Audio(audioUrl);
        await playAudioEl(audio);
        return;
      } catch (e) {
        console.warn("Direct audio URL playback notice:", e);
      }
    }

    // 2ND PRIORITY: Server TTS (/api/tts), one request per segment.
    for (let i = 0; i < segments.length; i++) {
      // If the user tapped the mic mid-answer (barge-in), stop the rest.
      if (i > 0 && !isSpeakingRef.current) break;
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: segments[i], language: effectiveLang })
        });

        const contentType = res.headers.get('content-type') || '';
        if (res.ok && contentType.includes('application/json')) {
          const data = await res.json();
          if (data && data.audioBase64) {
            // mp3 (Edge) or wav (Sarvam) — pick the right MIME for the provider.
            const mime = data.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
            const audio = new Audio(`data:${mime};base64,${data.audioBase64}`);
            await playAudioEl(audio);
          }
        }
      } catch (err) {
        console.warn("Server TTS request notice:", err);
        break;
      }
    }
  };

  // Gentle, non-repetitive feedback when nothing was heard. In the failing case
  // it also points the user to add a PHOTO of the problem (never silence).
  const pushNoSpeechHelp = () => {
    const now = Date.now();
    if (now - lastNoSpeechPromptRef.current < 6000) return; // avoid spam
    lastNoSpeechPromptRef.current = now;

    const noSpeechText = language === 'Kannada'
      ? "ಕ್ಷಮಿಸಿ, ನಿಮ್ಮ ಮಾತು ಸ್ಪಷ್ಟವಾಗಿ ಕೇಳಿಸಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಮತ್ತೊಮ್ಮೆ ಪ್ರಯತ್ನಿಸಿ, ಟೈಪ್ ಮಾಡಿ, ಅಥವಾ ಸಮಸ್ಯೆಯ ಆಹಾರದ ಫೋಟೋ ಸೇರಿಸಿ."
      : language === 'Hindi'
        ? "माफ़ कीजिए, आपकी आवाज़ स्पष्ट नहीं सुनाई दी। कृपया फिर से बोलें, टाइप करें, या समस्या की फोटो जोड़ें।"
        : "Sorry, I couldn't hear you clearly. Please try once more, type your issue, or add a photo of the problem so we can help faster.";

    const helpMsg: VoiceInteraction = {
      id: (Date.now() + 1).toString(),
      text: noSpeechText,
      sender: 'assistant',
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, helpMsg]);
    speak(noSpeechText, undefined, helpMsg.id, language);
  };

  const stopListeningAndSend = async (showNoSpeechHelp = false) => {
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
    
    // 1ST PRIORITY: Free native Browser Web Speech API (Chrome/Edge/Safari/Android/Kotlin-like)
    if (browserCaptured && !isHallucinatedText(browserCaptured)) {
      setTranscript(browserCaptured);
      transcriptRef.current = '';
      finalTranscriptRef.current = '';
      interimTranscriptRef.current = '';
      handleSendMessage(browserCaptured);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        stopAndTranscribeAudio().catch(() => {});
      }
      return;
    }

    // 2ND PRIORITY: Backend STT fallback (only if MediaRecorder was used on browsers lacking SpeechRecognition)
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      setIsLoading(true);
      const serverText = await stopAndTranscribeAudio();
      setIsLoading(false);

      if (serverText && serverText.trim() && !isHallucinatedText(serverText.trim())) {
        setTranscript(serverText.trim());
        transcriptRef.current = '';
        finalTranscriptRef.current = '';
        interimTranscriptRef.current = '';
        handleSendMessage(serverText.trim());
      } else {
        setTranscript('');
        transcriptRef.current = '';
        finalTranscriptRef.current = '';
        interimTranscriptRef.current = '';
        // A recording was attempted but the STT heard nothing (low/quiet sound).
        if (showNoSpeechHelp) {
          pushNoSpeechHelp();
        }
      }
    } else {
      setTranscript('');
      transcriptRef.current = '';
      finalTranscriptRef.current = '';
      interimTranscriptRef.current = '';
      // No transcript at all: only nudge if listening ran a while or the silent
      // watchdog asked for it — quick accidental taps stay silent.
      const listenedMs = Date.now() - listenStartRef.current;
      if (showNoSpeechHelp || listenedMs >= 2500) {
        pushNoSpeechHelp();
      }
    }
  };

  const startListeningProcess = async () => {
    stopSpeaking();
    // ONE mic session at a time: ignore a second start while already listening
    // or while the assistant's voice is playing (no double "ding", no echo).
    if (isListeningRef.current || isSpeakingRef.current || activeAudioRef.current) {
      return;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setTranscript('');
    transcriptRef.current = '';
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    silentRestartsRef.current = 0;
    listenStartRef.current = Date.now();
    updateListeningState(true);
    
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    // Direct Browser Web Speech API (Native, instant, 100% Kotlin-like clean behavior)
    // Avoid starting MediaRecorder simultaneously to eliminate mic hardware conflict & double "ding ding" sound on Chrome/Android!
    if (SpeechRecognition && recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch (e) {
        console.warn("Native speech recognition start notice:", e);
      }
    } else {
      // Fallback for browsers without native SpeechRecognition (e.g. Firefox desktop)
      try {
        await startRecording();
      } catch (recErr) {
        console.warn("Audio recorder initialization notice:", recErr);
      }
    }
  };

  const toggleListening = async () => {
    // 1. If AI is speaking -> INTERRUPT! Stop speech immediately and start listening to user
    if (isSpeakingRef.current || isSpeaking || activeAudioRef.current) {
      stopSpeaking();
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

    // LANGUAGE FOLLOW: reply and speak in the language the user actually used.
    // Kannada/Hindi text (typed or recognized) overrides the English UI pill so
    // the assistant never answers English to a Kannada speaker.
    const queryScript = detectTextScript(queryText);
    const effectiveLang = (queryScript !== 'English' ? queryScript : language) as 'English' | 'Hindi' | 'Kannada';
    if (effectiveLang !== language) {
      setLanguage(effectiveLang);
    }

    const recentHistory = messages.slice(-8).map(m => ({
      role: m.sender === 'user' ? 'user' : 'assistant',
      content: m.text
    }));

    const userTurnCount = messages.filter(m => m.sender === 'user').length + 1;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: queryText, 
          history: recentHistory,
          language: effectiveLang, 
          profile,
          chatCount: userTurnCount
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
      const spokenVoiceText = data.spokenText || assistantReply;
      const assistantMsg: VoiceInteraction = { 
        id: (Date.now() + 1).toString(), 
        text: assistantReply, 
        sender: 'assistant', 
        timestamp: Date.now(),
        audioUrl: data.audioUrl || undefined
      };
      
      setMessages(prev => [...prev, assistantMsg]);

      // Speak the reply in the language the user actually used (server confirms
      // it via detectedLanguage when it overrode the request language).
      const replyLang = data.detectedLanguage && ['English', 'Hindi', 'Kannada'].includes(data.detectedLanguage)
        ? data.detectedLanguage as 'English' | 'Hindi' | 'Kannada'
        : effectiveLang;
      if (replyLang !== language) {
        setLanguage(replyLang);
      }
      speak(spokenVoiceText, data.audioUrl, assistantMsg.id, replyLang);

      // Detect if AI suggested a complaint
      if (data.isComplaintDraft) {
        setComplaintDraft({ 
          query: queryText, 
          markdownReport: data.markdownReport || assistantReply,
          media: [] 
        });
      }
    } catch (error: any) { 
      console.error("Chat error:", error);
      let errorText = "I'm having trouble connecting to the AI service. Please try again shortly.";
      if (effectiveLang === 'Kannada') {
        errorText = "ಕ್ಷಮಿಸಿ, ಸೇವೆಯನ್ನು ಸಂಪರ್ಕಿಸುವಲ್ಲಿ ಅಡಚಣೆ ಉಂಟಾಗಿದೆ. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಪುನಃ ಪ್ರಯತ್ನಿಸಿ.";
      } else if (effectiveLang === 'Hindi') {
        errorText = "माफ़ कीजिए, सेवा से कनेक्ट करने में समस्या आ रही है। कृपया थोड़ी देर बाद पुनः प्रयास करें।";
      }

      const fallbackMsg: VoiceInteraction = {
        id: (Date.now() + 1).toString(),
        text: errorText,
        sender: 'assistant',
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, fallbackMsg]);
      speak(fallbackMsg.text, undefined, fallbackMsg.id, effectiveLang);
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
      query: complaintDraft.markdownReport || complaintDraft.query,
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
      className="flex flex-col h-[calc(100vh-5.5rem)] max-w-lg mx-auto relative px-3 sm:px-4"
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
            {/* Massive PEPERO Font Style Wordmark: VOX-ASSIST */}
            <div className="shrink-0 pt-2 pb-0 text-center select-none flex justify-center">
              <h1 
                className="font-brand-display tracking-tighter text-white drop-shadow-md transform -skew-x-6 inline-block"
                style={{
                  width: '333.362px',
                  height: '108.0057px',
                  fontSize: '88px',
                  textAlign: 'left',
                  lineHeight: '70px',
                }}
              >
                VOX-ASSIST
              </h1>
            </div>

            {/* Language Switcher Bar */}
            <div className="shrink-0 flex justify-center gap-1.5 p-1 bg-white/20 backdrop-blur-xl rounded-2xl border border-white/30 shadow-md w-fit mx-auto mt-1 mb-2">
              {(['English', 'Hindi', 'Kannada'] as const).map((lang) => {
                const labelMap = { English: 'English', Hindi: 'हिन्दी', Kannada: 'ಕನ್ನಡ' };
                return (
                  <button
                    key={lang}
                    onClick={() => {
                      setLanguage(lang);
                      if (synthRef.current) synthRef.current.cancel();
                    }}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold tracking-wide transition-all ${
                      language === lang 
                        ? 'bg-white text-rose-600 shadow-md font-black scale-[1.02]' 
                        : 'text-white/80 hover:text-white hover:bg-white/10'
                    }`}
                  >
                    {labelMap[lang]}
                  </button>
                );
              })}
            </div>

            {/* Middle Big 3D Sphere */}
            <div className="flex-1 flex flex-col items-center justify-center py-2 space-y-3">
              <ParticleBall
                isListening={isListening}
                isSpeaking={isSpeaking}
                isLoading={isLoading}
                onClick={toggleListening}
                audioStream={micStream}
                compact={false}
              />

              <div className="text-center max-w-sm px-2">
                <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight drop-shadow-sm">
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
                      className="text-white/95 font-bold text-xs tracking-wide px-2"
                    >
                      {transcript || (
                        isListening 
                          ? "Listening... Speak your query clearly" 
                          : ""
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
                className="shrink-0 mb-2 px-4 py-2 bg-white/25 hover:bg-white/35 backdrop-blur-xl border border-white/40 text-white text-xs font-bold rounded-2xl flex items-center gap-1.5 shadow-md transition-all"
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
            <div className="shrink-0 flex items-center justify-between gap-2 p-2 bg-white/20 backdrop-blur-xl rounded-2xl border border-white/30 shadow-md z-10 mb-1">
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
                  <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span className="font-brand-display text-base text-white tracking-tight">VOX-ASSIST</span>
                    {isListening && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />}
                  </h3>
                  <p className="text-[10px] text-white/90 font-bold truncate max-w-[110px] sm:max-w-[150px]">
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
                <div className="flex items-center gap-1 p-0.5 bg-white/20 rounded-xl border border-white/30">
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
                            ? 'bg-white text-rose-600 shadow-sm' 
                            : 'text-white/80 hover:text-white hover:bg-white/15'
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
                  className="p-1.5 rounded-xl bg-white/20 hover:bg-white/30 text-white transition-colors border border-white/30"
                  title="Minimize chat to main sphere"
                >
                  <ChevronDown size={17} />
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
                    className={`p-3.5 rounded-2xl max-w-[88%] shadow-lg transition-all ${
                      m.sender === 'user' 
                      ? 'bg-white/25 backdrop-blur-xl border border-white/35 text-white self-end shadow-black/10 rounded-br-xs' 
                      : 'bg-white/15 backdrop-blur-2xl border border-white/25 text-white self-start shadow-black/10 rounded-bl-xs'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        {m.sender === 'assistant' && (m.text.includes('# ') || m.text.includes('### ') || m.text.includes('| Parameter |') || m.text.includes('|---')) ? (
                          <RenderedMarkdown content={m.text} variant="glass" />
                        ) : (
                          <p className="text-xs sm:text-sm font-medium leading-relaxed whitespace-pre-wrap text-white">{m.text}</p>
                        )}
                      </div>
                      {m.sender === 'assistant' && (
                        <button 
                          onClick={() => {
                            if (isSpeaking && playingMsgId === m.id) {
                              stopSpeaking();
                            } else {
                              speak(m.text, m.audioUrl, m.id);
                            }
                          }}
                          className={`p-1.5 rounded-xl transition-all shrink-0 flex items-center gap-1 font-bold text-[10px] ${
                            isSpeaking && playingMsgId === m.id
                              ? 'bg-white text-rose-600 border border-white animate-pulse shadow-sm'
                              : 'text-white/80 hover:text-white bg-white/15 hover:bg-white/25 border border-white/20'
                          }`}
                          title={isSpeaking && playingMsgId === m.id ? "Mute / Stop Audio" : "Play Voice Answer"}
                        >
                          {isSpeaking && playingMsgId === m.id ? (
                            <>
                              <VolumeX size={15} className="text-rose-600" />
                              <span>Mute</span>
                            </>
                          ) : (
                            <Volume2 size={15} />
                          )}
                        </button>
                      )}
                    </div>
                    <div className={`text-[9px] font-bold uppercase tracking-wider mt-1.5 opacity-70 ${m.sender === 'user' ? 'text-right text-white/80' : 'text-left text-white/70'}`}>
                      {m.sender === 'user' ? (profile.name || 'You') : 'VOX-ASSIST'} • {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {isLoading && (
                <div className="flex items-center gap-2 bg-white/20 backdrop-blur-xl w-fit px-3.5 py-2.5 rounded-2xl border border-white/30 shadow-md text-white self-start">
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                  <span className="text-[11px] font-bold uppercase tracking-wider text-white">Generating answer...</span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* BOTTOM CHAT & MIC BAR: 100% Glassmorphism, NO white background */}
      <div className="shrink-0 sticky bottom-0 bg-transparent pt-2 pb-1 space-y-2 z-20">
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

            {complaintDraft.markdownReport && (
              <div className="bg-white/95 p-3 rounded-xl border border-amber-200 shadow-2xs max-h-56 overflow-y-auto">
                <RenderedMarkdown content={complaintDraft.markdownReport} />
              </div>
            )}

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

        {/* Glassmorphic Transparent Chat Input & Mic Form */}
        <form 
          onSubmit={(e) => {
            e.preventDefault();
            if (manualText.trim()) {
              setIsMinimized(false);
              handleSendMessage(manualText);
            }
          }}
          className="flex items-center gap-2 bg-white/15 backdrop-blur-2xl p-1.5 sm:p-2 rounded-2xl border border-white/30 shadow-xl shadow-black/10 focus-within:border-white/60 focus-within:bg-white/20 transition-all"
        >
          <button
            type="button"
            onClick={() => {
              setIsMinimized(false);
              toggleListening();
            }}
            className={`p-2.5 rounded-xl transition-all ${
              isListening 
                ? 'bg-rose-500 text-white animate-pulse shadow-md shadow-rose-900/30' 
                : 'bg-white/20 hover:bg-white/30 text-white border border-white/30 active:scale-95'
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
            className="flex-1 bg-transparent px-3 py-2 text-xs sm:text-sm font-semibold text-white placeholder-white/65 focus:outline-none border-none"
          />

          <button
            type="submit"
            disabled={!manualText.trim() || isLoading}
            className="p-2.5 bg-white/25 hover:bg-white/35 active:scale-95 text-white rounded-xl transition-all disabled:opacity-40 border border-white/30 shadow-md flex items-center justify-center shrink-0 cursor-pointer"
          >
            <Send size={16} />
          </button>
        </form>

        {/* Identity Alert */}
        {!profile.name && (
          <div className="bg-white/15 backdrop-blur-md p-2 rounded-xl border border-white/25 flex items-center gap-2 shadow-sm text-white">
            <Sparkles size={14} className="text-white shrink-0" />
            <p className="text-[10px] text-white/90 font-medium">
              Tip: Set your name and phone in profile to personalize answers.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

