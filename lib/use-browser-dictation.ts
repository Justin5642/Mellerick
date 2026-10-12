"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Browser speech-to-text (the Web Speech API) for "Record note" on the web job
// page. Replaces the old record -> upload -> OpenAI Whisper round trip: the
// words appear as you speak and nothing is sent to OpenAI. Chrome, Edge and
// Safari support it; where a browser does not (Firefox), `available` is false
// and the button is hidden — typing still works everywhere.
//
// The API is not in TypeScript's DOM lib, so the slice used here is typed by
// hand.

interface RecognitionAlternative { transcript: string }
interface RecognitionResult { isFinal: boolean; length: number; [i: number]: RecognitionAlternative }
interface RecognitionResultList { length: number; [i: number]: RecognitionResult }
interface RecognitionEvent { results: RecognitionResultList }
interface RecognitionErrorEvent { error: string }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** The whole transcript so far: every result in order, finals and the current interim. */
export function transcriptOf(results: RecognitionResultList): string {
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const said = results[i][0]?.transcript?.trim();
    if (said) parts.push(said);
  }
  return parts.join(" ");
}

export function useBrowserDictation(onDone: (text: string) => void, onError: (message: string) => void) {
  // Decided after mount: the server render has no window, and guessing there
  // would mismatch on hydration.
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const recognition = useRef<Recognition | null>(null);
  const latest = useRef("");
  const callbacks = useRef({ onDone, onError });
  callbacks.current = { onDone, onError };

  useEffect(() => {
    setAvailable(recognitionCtor() !== null);
    return () => recognition.current?.abort();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recognition.current) return;
    const r = new Ctor();
    r.lang = "en-AU";
    r.continuous = true;
    r.interimResults = true;
    latest.current = "";
    setText("");
    r.onresult = (e) => {
      latest.current = transcriptOf(e.results);
      setText(latest.current);
    };
    r.onerror = (e) => {
      // "no-speech" ends with empty text (handled at onend); "aborted" is us.
      if (e.error === "no-speech" || e.error === "aborted") return;
      callbacks.current.onError(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access is blocked — allow it for this site in your browser."
          : e.error === "network"
            ? "Couldn't reach the speech service. Check your connection, or type the note."
            : `Dictation stopped (${e.error}).`
      );
    };
    r.onend = () => {
      recognition.current = null;
      setListening(false);
      callbacks.current.onDone(latest.current.trim());
    };
    recognition.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      recognition.current = null;
      callbacks.current.onError("Couldn't start dictation.");
    }
  }, []);

  const stop = useCallback(() => recognition.current?.stop(), []);

  return { available, listening, text, start, stop };
}
