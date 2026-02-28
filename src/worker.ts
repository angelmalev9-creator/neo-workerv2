import { useState, useRef, useCallback, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface UseGeminiVoiceProps {
  onMessage?: (message: Message) => void;
  onError?: (error: string) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onListeningChange?: (listening: boolean) => void;
  onTranscript?: (transcript: string, isFinal: boolean, role: "user" | "assistant") => void;
}

type SessionData = {
  apiKey: string;
  model: string;
  systemInstruction: string;
};

interface DgSTTState {
  ws: WebSocket | null;
  isReady: boolean;
}

const MAX_SYSTEM_INSTRUCTION_CHARS = 200000;
const AUDIO_SAMPLE_RATE_OUT = 24000;
const AUDIO_SAMPLE_RATE_IN = 16000;

const ECHO_GUARD_MS = 120;
const ANTI_BARGE_IN_MS = 400;
const MIN_BARGE_IN_CHARS = 3;
const MIN_BARGE_IN_WORDS = 1;
const BARGE_IN_COMMANDS = ["стоп", "спри", "изчакай", "чакай", "момент", "секунда"];

// We keep this low for responsiveness; Deepgram "utterance_end_ms" stays >= 1000 for stability.
const UTTERANCE_DEBOUNCE_MS = 120;

// Greeting retry if first turn is dropped / audio pipeline not yet stable
const GREETING_RETRY_MS = 1500;

const clampInstruction = (text: string, maxChars: number) => {
  const t = String(text || "").trim();
  if (t.length <= maxChars) return t;
  const head = t.slice(0, Math.floor(maxChars * 0.7));
  const tail = t.slice(-Math.floor(maxChars * 0.25));
  return `${head}\n\n[...СЪКРАТЕНО...]\n\n${tail}`;
};

function resampleTo16k(inputData: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === AUDIO_SAMPLE_RATE_IN) return new Float32Array(inputData);
  const ratio = inputSampleRate / AUDIO_SAMPLE_RATE_IN;
  const outputLength = Math.floor(inputData.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, inputData.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    output[i] = inputData[srcIndexFloor] * (1 - fraction) + inputData[srcIndexCeil] * fraction;
  }
  return output;
}

function float32ToInt16Buffer(float32Array: Float32Array): ArrayBuffer {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16Array.buffer;
}

function normalizeBgText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@._+-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldAllowBargeIn(text: string): boolean {
  const norm = normalizeBgText(text);
  if (!norm) return false;
  if (BARGE_IN_COMMANDS.some((w) => norm.includes(w))) return true;
  if (norm.length < MIN_BARGE_IN_CHARS) return false;
  const words = norm.split(" ").filter(Boolean);
  if (words.length < MIN_BARGE_IN_WORDS) return false;
  return true;
}

// Fast, stable string hash for prompt key (not crypto)
function hash32(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * CONTACT NORMALIZATION (deterministic)
 * Goal: get fast + correct email/phone from noisy BG speech/STT.
 */

const DIGIT_WORDS: Record<string, string> = {
  "нула": "0",
  "едно": "1",
  "една": "1",
  "две": "2",
  "три": "3",
  "четири": "4",
  "пет": "5",
  "шест": "6",
  "седем": "7",
  "осем": "8",
  "девет": "9",
  // English variants often appear in STT for digits
  "zero": "0",
  "one": "1",
  "two": "2",
  "three": "3",
  "four": "4",
  "five": "5",
  "six": "6",
  "seven": "7",
  "eight": "8",
  "nine": "9",
};

function normalizeEmailSpeech(raw: string): string {
  let s = String(raw || "").trim().toLowerCase();

  // Common BG “spelling” tokens
  s = s
    .replace(/\bмаймунско\b|\bмаймунка\b|\bat\b/g, "@")
    .replace(/\bточка\b|\bдот\b|\bdot\b/g, ".")
    .replace(/\bтире\b|\bdash\b/g, "-")
    .replace(/\bдолна\s+черта\b|\bunderscore\b/g, "_");

  // Remove spaces/commas between email characters
  s = s.replace(/[,\s]+/g, "");

  // Fix “gmail com” or “gmail. com”
  s = s.replace(/gmail\.?com/g, "gmail.com").replace(/abv\.?bg/g, "abv.bg");

  return s;
}

function extractEmail(text: string): string | null {
  const norm = normalizeEmailSpeech(text);
  const m = norm.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}

function normalizePhoneSpeech(raw: string): string {
  let s = String(raw || "").toLowerCase();

  // Replace digit words
  for (const [w, d] of Object.entries(DIGIT_WORDS)) {
    s = s.replace(new RegExp(`\\b${w}\\b`, "g"), d);
  }

  // Keep + and digits; remove separators
  s = s.replace(/[^\d+]/g, "");

  // Convert 00359 -> +359
  if (s.startsWith("00359")) s = "+359" + s.slice(5);

  // If user says "359..." without plus and it's long, accept as +359
  if (!s.startsWith("+") && s.startsWith("359") && s.length >= 11) s = "+" + s;

  return s;
}

function extractPhone(text: string): string | null {
  const norm = normalizePhoneSpeech(text);

  // BG mobile patterns: 08xxxxxxxx or +3598xxxxxxxx
  if (/^08\d{8,9}$/.test(norm)) return norm;
  if (/^\+3598\d{8,9}$/.test(norm)) return norm;

  // Generic: accept 9-15 digits (international), but avoid tiny junk
  const digitsOnly = norm.replace(/[^\d]/g, "");
  if (digitsOnly.length >= 9 && digitsOnly.length <= 15) return norm;

  return null;
}

function isValidEmail(email: string): boolean {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email.trim());
}

function isValidPhone(phone: string): boolean {
  const p = phone.trim();
  if (/^08\d{8,9}$/.test(p)) return true;
  if (/^\+3598\d{8,9}$/.test(p)) return true;
  const digits = p.replace(/[^\d]/g, "");
  return digits.length >= 9 && digits.length <= 15;
}

type ContactState = {
  name?: string;
  email?: string;
  phone?: string;
};

export const useGeminiVoice = ({
  onMessage,
  onError,
  onSpeakingChange,
  onListeningChange,
  onTranscript,
}: UseGeminiVoiceProps = {}) => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isPrepared, setIsPrepared] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);

  // ★ Ref mirrors — guards must read refs (never stale), state is for UI only
  const isPreparedRef = useRef(false);
  const isPreparingRef = useRef(false);
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const isProcessingQueueRef = useRef(false);
  const sessionDataRef = useRef<SessionData | null>(null);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const connectMutexRef = useRef(false);
  const companyNameRef = useRef<string>("");
  const silenceWatchdogRef = useRef<number | null>(null);
  const silenceNudgeSentRef = useRef(false);
  const silenceNudgeCountRef = useRef(0);
  const gainRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const scheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const actualSampleRateRef = useRef<number>(48000);
  const greetingSentRef = useRef(false);
  const greetingRetryTimerRef = useRef<number | null>(null);
  const firstAssistantAudioSeenRef = useRef(false);
  const firstAssistantTextSeenRef = useRef(false);

  const speakEndRef = useRef<number>(0);
  const speakStartRef = useRef<number>(0);
  const recentUtterancesRef = useRef<Array<{ text: string; ts: number }>>([]);
  const dgKeepAliveRef = useRef<number | null>(null);
  const currentResponseTextRef = useRef("");
  const dgSTTRef = useRef<DgSTTState>({ ws: null, isReady: false });
  const utteranceBufferRef = useRef<string[]>([]);
  const utteranceDebounceRef = useRef<number | null>(null);

  // Track what context we prepared for (sessionId/companyName/systemPrompt)
  const preparedKeyRef = useRef<string>("");

  // ✅ Last known good contact values (deterministic guard before actions)
  const contactRef = useRef<ContactState>({});

  const updateSpeaking = useCallback(
    (speaking: boolean) => {
      setIsSpeaking(speaking);
      onSpeakingChange?.(speaking);
      if (speaking) speakStartRef.current = Date.now();
      else speakEndRef.current = Date.now();
    },
    [onSpeakingChange],
  );

  const updateListening = useCallback(
    (listening: boolean) => {
      setIsListening(listening);
      onListeningChange?.(listening);
    },
    [onListeningChange],
  );

  const clearSilenceWatchdog = useCallback(() => {
    if (silenceWatchdogRef.current) {
      window.clearTimeout(silenceWatchdogRef.current);
      silenceWatchdogRef.current = null;
    }
  }, []);

  const sendToGemini = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        client_content: {
          turns: [{ role: "user", parts: [{ text }] }],
          turn_complete: true,
        },
      }),
    );
  }, []);

  const sendGreetingToGemini = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    currentResponseTextRef.current = "";
    ws.send(
      JSON.stringify({
        client_content: {
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: `SYSTEM: Нов входящ разговор. Кажи поздрав и попитай с какво можеш да помогнеш. Ти си НЕО от ${companyNameRef.current}. Максимум 2 изречения.`,
                },
              ],
            },
          ],
          turn_complete: true,
        },
      }),
    );
  }, []);

  const startSilenceWatchdog = useCallback(() => {
    clearSilenceWatchdog();
    silenceWatchdogRef.current = window.setTimeout(() => {
      if (isPlayingRef.current) return;
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      if (silenceNudgeCountRef.current >= 1) return;
      if (silenceNudgeSentRef.current) return;
      silenceNudgeSentRef.current = true;
      silenceNudgeCountRef.current += 1;
      sendToGemini("Все още ли сте на линия?");
    }, 25000);
  }, [clearSilenceWatchdog, sendToGemini]);

  const handleUtteranceRef = useRef<(text: string) => void>(() => {});

  const connectSTT = useCallback(() => {
    const dgApiKey = import.meta.env.VITE_DEEPGRAM_API_KEY as string | undefined;
    if (!dgApiKey || dgApiKey.trim() === "" || dgApiKey === "undefined") {
      onError?.("Липсва DEEPGRAM_API_KEY");
      return;
    }
    let cleanKey = dgApiKey.trim().replace(/^["']|["']$/g, "");
    cleanKey = cleanKey.replace(/^Bearer\s+/i, "").trim();

    const params = new URLSearchParams({
      model: "nova-2",
      language: "bg",
      encoding: "linear16",
      sample_rate: "16000",
      punctuate: "true",
      interim_results: "true",
      smart_format: "true",
      // ✅ Numerals helps a lot with "08, 77, 0..."
      numerals: "true",
      // Keep stable; don't go too aggressive here
      endpointing: "300",
      utterance_end_ms: "1000",
      vad_events: "true",
    });

    console.log("[STT] Connecting Nova-2 bg...");
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ["token", cleanKey]);
    const stt = dgSTTRef.current;
    stt.ws = ws;
    stt.isReady = false;

    ws.onopen = () => {
      console.log("[STT] ✅ Connected");
      stt.isReady = true;
      if (dgKeepAliveRef.current) clearInterval(dgKeepAliveRef.current);
      dgKeepAliveRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, 8000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data?.type === "SpeechStarted") return;
        if (data?.type === "UtteranceEnd") return;
        const alt = data?.channel?.alternatives?.[0];
        if (!alt) return;
        const transcript = (alt.transcript || "").trim();
        if (!transcript) return;

        if (!data.is_final) {
          onTranscript?.(transcript, false, "user");
          return;
        }

        utteranceBufferRef.current.push(transcript);
        onTranscript?.(utteranceBufferRef.current.join(" "), true, "user");

        if (utteranceDebounceRef.current) {
          window.clearTimeout(utteranceDebounceRef.current);
        }
        utteranceDebounceRef.current = window.setTimeout(() => {
          utteranceDebounceRef.current = null;
          const fullText = utteranceBufferRef.current.join(" ").trim();
          utteranceBufferRef.current = [];
          if (fullText) handleUtteranceRef.current(fullText);
        }, UTTERANCE_DEBOUNCE_MS);
      } catch (e) {
        console.error("[STT] parse err", e);
      }
    };

    ws.onerror = (e) => {
      console.error("[STT] error", e);
      onError?.("Deepgram STT грешка");
    };
    ws.onclose = (ev) => {
      console.log("[STT] Closed:", ev.code, ev.reason);
      stt.isReady = false;
      if (dgKeepAliveRef.current) {
        clearInterval(dgKeepAliveRef.current);
        dgKeepAliveRef.current = null;
      }
    };
  }, [onError, onTranscript]);

  const handleUserUtterance = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      // Guards vs echo / barge-in noise
      if (Date.now() - speakEndRef.current < ECHO_GUARD_MS) return;
      if (isPlayingRef.current && Date.now() - speakStartRef.current < ANTI_BARGE_IN_MS) return;
      if (isPlayingRef.current && !shouldAllowBargeIn(text)) return;

      // Duplicate guard
      const now = Date.now();
      const recent = recentUtterancesRef.current.filter((u) => now - u.ts < 2000);
      recentUtterancesRef.current = recent;
      const normalized = text.trim().toLowerCase();
      if (recent.some((u) => u.text === normalized)) return;
      recentUtterancesRef.current.push({ text: normalized, ts: now });

      clearSilenceWatchdog();
      silenceNudgeSentRef.current = false;

      // Stop TTS on barge-in
      if (isPlayingRef.current) {
        scheduledSourcesRef.current.forEach((s) => {
          try {
            s.stop();
          } catch {}
        });
        scheduledSourcesRef.current = [];
        if (activeSourceRef.current) {
          try {
            activeSourceRef.current.stop();
          } catch {}
          activeSourceRef.current = null;
        }
        audioQueueRef.current = [];
        isProcessingQueueRef.current = false;
        isPlayingRef.current = false;
        nextPlayTimeRef.current = 0;
        updateSpeaking(false);
      }

      // Emit user message
      onMessage?.({ role: "user", content: text });
      onTranscript?.(text, true, "user");

      // Deterministic contact extraction (fast + accurate)
      const email = extractEmail(text);
      const phone = extractPhone(text);

      if (email && isValidEmail(email)) {
        contactRef.current.email = email;
      }
      if (phone && isValidPhone(phone)) {
        contactRef.current.phone = phone;
      }

      console.log("[VOICE] → Gemini:", text.substring(0, 60));
      currentResponseTextRef.current = "";

      // Send to Gemini with a deterministic hint block (NO extra roundtrips)
      const contactHintParts: string[] = [];
      if (contactRef.current.email) contactHintParts.push(`email=${contactRef.current.email}`);
      if (contactRef.current.phone) contactHintParts.push(`phone=${contactRef.current.phone}`);

      const hint =
        contactHintParts.length > 0
          ? `\n\n[CONTACT_PARSED ${contactHintParts.join(" ")}]\nПравило: използвай само тези стойности за имейл/телефон. Ако липсва, поискай го пак.`
          : "";

      sendToGemini(`${text}${hint}`);
    },
    [clearSilenceWatchdog, updateSpeaking, onMessage, onTranscript, sendToGemini],
  );

  useEffect(() => {
    handleUtteranceRef.current = handleUserUtterance;
  }, [handleUserUtterance]);

  const processAudioQueue = useCallback(async () => {
    if (isProcessingQueueRef.current || audioQueueRef.current.length === 0 || !audioContextRef.current) return;
    isProcessingQueueRef.current = true;
    isPlayingRef.current = true;
    updateSpeaking(true);
    updateListening(false);

    const ctx = audioContextRef.current;
    if (!gainRef.current) {
      gainRef.current = ctx.createGain();
      gainRef.current.gain.value = 1.3;
      gainRef.current.connect(ctx.destination);
    }
    if (nextPlayTimeRef.current < ctx.currentTime) nextPlayTimeRef.current = ctx.currentTime + 0.005;

    while (audioQueueRef.current.length > 0) {
      const audioData = audioQueueRef.current.shift();
      if (!audioData) continue;
      const buffer = ctx.createBuffer(1, audioData.length, AUDIO_SAMPLE_RATE_OUT);
      buffer.getChannelData(0).set(audioData);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = 1.0;
      activeSourceRef.current = source;
      source.connect(gainRef.current!);
      source.start(nextPlayTimeRef.current);
      scheduledSourcesRef.current.push(source);
      nextPlayTimeRef.current += buffer.duration / 1.0;

      source.onended = () => {
        const idx = scheduledSourcesRef.current.indexOf(source);
        if (idx > -1) scheduledSourcesRef.current.splice(idx, 1);
        if (scheduledSourcesRef.current.length === 0 && audioQueueRef.current.length === 0) {
          isPlayingRef.current = false;
          updateSpeaking(false);
          updateListening(true);
          startSilenceWatchdog();
        }
      };
    }
    isProcessingQueueRef.current = false;
  }, [updateSpeaking, updateListening, startSilenceWatchdog]);

  const playAudioChunk = useCallback(
    (base64Audio: string) => {
      if (!audioContextRef.current) return;
      try {
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768;
        audioQueueRef.current.push(float32Array);
        firstAssistantAudioSeenRef.current = true;
        processAudioQueue();
      } catch {}
    },
    [processAudioQueue],
  );

  const startAudioCapture = useCallback(() => {
    if (!streamRef.current || !audioContextRef.current) return;
    const ctx = audioContextRef.current;
    const track = streamRef.current.getAudioTracks()[0];
    if (!track) return;
    track.enabled = true;

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {}
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {}
      sourceRef.current = null;
    }
    if (ctx.state === "suspended") ctx.resume();

    actualSampleRateRef.current = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    sourceRef.current = source;
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (Date.now() - speakEndRef.current < ECHO_GUARD_MS) return;
      const stt = dgSTTRef.current;
      if (!stt.ws || stt.ws.readyState !== WebSocket.OPEN || !stt.isReady) return;
      const inputData = e.inputBuffer?.getChannelData(0);
      if (!inputData) return;
      try {
        stt.ws.send(float32ToInt16Buffer(resampleTo16k(inputData, actualSampleRateRef.current)));
      } catch {}
    };

    source.connect(processor);
    processor.connect(ctx.destination);
    updateListening(true);
    console.log("[MIC] ✅ Capturing (always-on)");
  }, [updateListening]);

  const resetPreparedSession = useCallback(() => {
    sessionDataRef.current = null;
    preparedKeyRef.current = "";
    isPreparedRef.current = false;
    setIsPrepared(false);
    greetingSentRef.current = false;
    currentResponseTextRef.current = "";
    firstAssistantAudioSeenRef.current = false;
    firstAssistantTextSeenRef.current = false;
    if (greetingRetryTimerRef.current) {
      window.clearTimeout(greetingRetryTimerRef.current);
      greetingRetryTimerRef.current = null;
    }
  }, []);

  const prepareSession = useCallback(
    async (systemPrompt: string, companyName: string, sessionId?: string) => {
      const key = `${sessionId || ""}::${companyName || ""}::${hash32(systemPrompt || "")}`;

      if (isPreparingRef.current) return;
      if (isPreparedRef.current && sessionDataRef.current && preparedKeyRef.current === key) return;

      if (preparedKeyRef.current && preparedKeyRef.current !== key) {
        console.log("[SESSION] 🔄 Context changed → reset prepared session");
        resetPreparedSession();
      }

      isPreparingRef.current = true;
      setIsPreparing(true);
      companyNameRef.current = companyName;

      try {
        const anonKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string) || "";
        const response = await fetch("https://onufuxczpqlxxkgyltlz.supabase.co/functions/v1/gemini-session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`,
          },
          body: JSON.stringify({
            systemPrompt,
            companyName,
            sessionId,
          }),
        });

        if (!response.ok) throw new Error("Session prep failed");
        const data = await response.json();
        if (!data?.success) throw new Error(data?.error || "Session failed");

        sessionDataRef.current = {
          apiKey: data.apiKey,
          model: data.model,
          systemInstruction: clampInstruction(data.systemInstruction || "", MAX_SYSTEM_INSTRUCTION_CHARS),
        };

        preparedKeyRef.current = key;

        console.log(
          "[SESSION] ✅ Ready, model:",
          data.model,
          "| instruction:",
          sessionDataRef.current.systemInstruction.length,
          "chars | key:",
          key,
        );
        isPreparedRef.current = true;
        setIsPrepared(true);
      } catch (e) {
        onError?.(e instanceof Error ? e.message : "Prepare failed");
      } finally {
        isPreparingRef.current = false;
        setIsPreparing(false);
      }
    },
    [onError, resetPreparedSession],
  );

  const preWarmMicrophone = useCallback(async () => {
    if (streamRef.current) return;
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {}
  }, []);

  const disconnect = useCallback(() => {
    clearSilenceWatchdog();
    silenceNudgeSentRef.current = false;
    silenceNudgeCountRef.current = 0;

    if (greetingRetryTimerRef.current) {
      window.clearTimeout(greetingRetryTimerRef.current);
      greetingRetryTimerRef.current = null;
    }

    if (dgKeepAliveRef.current) {
      clearInterval(dgKeepAliveRef.current);
      dgKeepAliveRef.current = null;
    }

    const stt = dgSTTRef.current;
    if (stt.ws) {
      try {
        stt.ws.close();
      } catch {}
      stt.ws = null;
    }
    stt.isReady = false;

    connectMutexRef.current = false;
    greetingSentRef.current = false;

    isPreparedRef.current = false;
    setIsPrepared(false);

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {}
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {}
      sourceRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }
    if (gainRef.current) {
      try {
        gainRef.current.disconnect();
      } catch {}
      gainRef.current = null;
    }
    scheduledSourcesRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    scheduledSourcesRef.current = [];
    if (activeSourceRef.current) {
      try {
        activeSourceRef.current.stop();
      } catch {}
      activeSourceRef.current = null;
    }
    audioQueueRef.current = [];
    isProcessingQueueRef.current = false;
    isPlayingRef.current = false;
    nextPlayTimeRef.current = 0;

    isConnectedRef.current = false;
    isConnectingRef.current = false;
    setIsConnected(false);
    setIsConnecting(false);
    setIsSpeaking(false);
    setIsListening(false);
  }, [clearSilenceWatchdog]);

  // ✅ FE → Edge proxy (no secrets in FE)
  // ✅ NEW: guard action if email/phone invalid or missing
  const maybeExecuteActionFromGemini = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed.startsWith("{")) return false;

      try {
        const parsed = JSON.parse(trimmed);

        if (parsed?.type !== "action_request") return false;
        if (parsed?.action !== "submit_form") return false;

        // HARD GATE: require valid contact before sending to worker
        const email = contactRef.current.email;
        const phone = contactRef.current.phone;

        // If worker payload contains fields, try to validate those too
        const payloadEmail: string | undefined =
          parsed?.payload?.email || parsed?.fields?.email || parsed?.form_data?.email || undefined;
        const payloadPhone: string | undefined =
          parsed?.payload?.phone || parsed?.fields?.phone || parsed?.form_data?.phone || undefined;

        const finalEmail = payloadEmail && isValidEmail(payloadEmail) ? payloadEmail : email;
        const finalPhone = payloadPhone && isValidPhone(payloadPhone) ? payloadPhone : phone;

        if (!finalEmail || !isValidEmail(finalEmail)) {
          onMessage?.({
            role: "assistant",
            content: "Имейлът не е валиден. Кажете го пак (например: name маймунско gmail точка com).",
          });
          return true;
        }
        if (!finalPhone || !isValidPhone(finalPhone)) {
          onMessage?.({
            role: "assistant",
            content: "Телефонът не е валиден. Кажете целия номер наведнъж (например: 08 77 00 00 88).",
          });
          return true;
        }

        const anonKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string) || "";
        if (!anonKey) {
          onError?.("Липсва VITE_SUPABASE_PUBLISHABLE_KEY");
          return true;
        }

        // Inject normalized contacts into payload when possible (deterministic)
        if (!parsed.payload) parsed.payload = {};
        if (!parsed.payload.email) parsed.payload.email = finalEmail;
        if (!parsed.payload.phone) parsed.payload.phone = finalPhone;

        const proxyUrl = "https://onufuxczpqlxxkgyltlz.supabase.co/functions/v1/neo-worker-proxy";
        console.log("[ACTION] → neo-worker-proxy:", parsed);

        const res = await fetch(proxyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`,
          },
          body: JSON.stringify(parsed),
        });

        const result = await res.json().catch(() => ({}));
        console.log("[PROXY RESULT]:", result);

        if (result?.success) {
          onMessage?.({
            role: "assistant",
            content: "Готово — подадох запитването през формата.",
          });
        } else {
          onMessage?.({
            role: "assistant",
            content: "Не успях да подам запитването през формата. Кажете ми дали да опитам пак.",
          });
        }

        return true;
      } catch {
        return false;
      }
    },
    [onError, onMessage],
  );

  const connect = useCallback(
    async (systemPrompt: string, companyName: string, sessionId?: string) => {
      const key = `${sessionId || ""}::${companyName || ""}::${hash32(systemPrompt || "")}`;

      if (isConnectedRef.current && preparedKeyRef.current && preparedKeyRef.current !== key) {
        console.log("[CONNECT] 🔄 Context changed while connected → reconnect WS");
        disconnect();
      }

      if (connectMutexRef.current || isConnectedRef.current || isConnectingRef.current) return;
      connectMutexRef.current = true;
      isConnectingRef.current = true;
      setIsConnecting(true);

      try {
        await prepareSession(systemPrompt, companyName, sessionId);

        if (!streamRef.current) {
          streamRef.current = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        }

        audioContextRef.current = new AudioContext();
        if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume();

        const session = sessionDataRef.current;
        if (!session) throw new Error("No session");

        const isLive001 = session.model.includes("2.0-flash-live");
        const isNativeAudioPreview = session.model.includes("native-audio");
        const apiVersion = isLive001 || isNativeAudioPreview ? "v1alpha" : "v1beta";
        console.log("[CONNECT] Gemini WS, model:", session.model, "api:", apiVersion);

        const ws = new WebSocket(
          `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContent?key=${session.apiKey}`,
        );
        wsRef.current = ws;

        ws.onopen = () => {
          const setupPayload: any = {
            setup: {
              model: `models/${session.model}`,
              generation_config: {
                response_modalities: ["AUDIO"],
                temperature: 0.4,
                max_output_tokens: 2048,
                speech_config: {
                  voice_config: { prebuilt_voice_config: { voice_name: "Puck" } },
                },
                thinking_config: { thinking_budget: 0 },
              },
              system_instruction: { parts: [{ text: session.systemInstruction }] },
            },
          };

          const isNativeAudio = session.model.includes("native-audio");
          if (isNativeAudio) setupPayload.setup.output_audio_transcription = {};

          ws.send(JSON.stringify(setupPayload));
          console.log("[GEMINI] Setup sent — thinking=OFF, voice=Puck");
        };

        ws.onmessage = async (event) => {
          const data = JSON.parse(event.data instanceof Blob ? await event.data.text() : event.data);

          if (data?.setupComplete || data?.setup_complete) {
            console.log("[GEMINI] ✅ Ready — LLM + Voice, zero thinking");
            isConnectedRef.current = true;
            isConnectingRef.current = false;
            setIsConnected(true);
            setIsConnecting(false);

            startAudioCapture();
            connectSTT();

            if (!greetingSentRef.current) {
              greetingSentRef.current = true;
              firstAssistantAudioSeenRef.current = false;
              firstAssistantTextSeenRef.current = false;

              // send once now
              sendGreetingToGemini();

              // and retry once if nothing comes out (dropped first turn)
              if (greetingRetryTimerRef.current) window.clearTimeout(greetingRetryTimerRef.current);
              greetingRetryTimerRef.current = window.setTimeout(() => {
                greetingRetryTimerRef.current = null;
                if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
                if (firstAssistantAudioSeenRef.current || firstAssistantTextSeenRef.current) return;
                console.log("[GREET] retry");
                sendGreetingToGemini();
              }, GREETING_RETRY_MS);
            }
          }

          const content = data?.serverContent || data?.server_content;
          if (!content) return;

          const modelTurn = content.modelTurn || content.model_turn;
          if (modelTurn?.parts) {
            for (const part of modelTurn.parts) {
              if (part.inlineData?.data) {
                clearSilenceWatchdog();
                playAudioChunk(part.inlineData.data);
              }
            }
          }

          const transcription =
            content.outputTranscription ||
            content.output_transcription ||
            content.outputAudioTranscription ||
            content.output_audio_transcription;

          if (transcription?.text) {
            const txt = transcription.text.trim();
            if (txt && !txt.startsWith("**") && !txt.includes(">>>") && !txt.includes("<<<")) {
              firstAssistantTextSeenRef.current = true;

              if (currentResponseTextRef.current && !currentResponseTextRef.current.endsWith(" ")) {
                currentResponseTextRef.current += " ";
              }
              currentResponseTextRef.current += txt;
              onTranscript?.(currentResponseTextRef.current, false, "assistant");
            }
          }

          if (content.turnComplete || content.turn_complete) {
            const responseText = currentResponseTextRef.current.trim();

            if (responseText) {
              const handled = await maybeExecuteActionFromGemini(responseText);

              if (!handled) {
                onMessage?.({ role: "assistant", content: responseText });
                onTranscript?.(responseText, true, "assistant");
              }
            }

            currentResponseTextRef.current = "";
          }
        };

        ws.onerror = () => {
          connectMutexRef.current = false;
          disconnect();
        };
        ws.onclose = (ev) => {
          console.log("[GEMINI] Closed:", ev.code, ev.reason);
          connectMutexRef.current = false;
          isConnectedRef.current = false;
          setIsConnected(false);
        };
      } catch (e) {
        connectMutexRef.current = false;
        isConnectingRef.current = false;
        setIsConnecting(false);
        onError?.(e instanceof Error ? e.message : "Connection failed");
        disconnect();
      }
    },
    [
      prepareSession,
      disconnect,
      onError,
      onMessage,
      onTranscript,
      startAudioCapture,
      connectSTT,
      playAudioChunk,
      clearSilenceWatchdog,
      maybeExecuteActionFromGemini,
      sendGreetingToGemini,
    ],
  );

  const sendText = useCallback((text: string) => handleUserUtterance(text), [handleUserUtterance]);

  useEffect(() => () => disconnect(), [disconnect]);

  useEffect(() => {
    const resume = async () => {
      if (audioContextRef.current?.state === "suspended") await audioContextRef.current.resume();
    };
    const events = ["touchstart", "touchend", "click", "keydown"];
    events.forEach((e) => document.addEventListener(e, resume, { passive: true }));
    return () => events.forEach((e) => document.removeEventListener(e, resume));
  }, []);

  return {
    isConnected,
    isConnecting,
    isSpeaking,
    isListening,
    connect,
    disconnect,
    prepareSession,
    preWarmMicrophone,
    sendText,
    interrupt: () => {
      scheduledSourcesRef.current.forEach((s) => {
        try {
          s.stop();
        } catch {}
      });
      scheduledSourcesRef.current = [];
      audioQueueRef.current = [];
      isProcessingQueueRef.current = false;
      isPlayingRef.current = false;
      nextPlayTimeRef.current = 0;
      updateSpeaking(false);
    },
  };
};
