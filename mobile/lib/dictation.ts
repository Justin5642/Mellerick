import { useCallback, useEffect, useRef, useState } from "react";

// Speech-to-text on the phone itself (Apple / Google speech recognition — the
// same engine as keyboard dictation), replacing the old record -> upload ->
// OpenAI Whisper round trip. Used by "Record note" (components/job/notes.tsx)
// and the job voice report (components/job/voice-report.tsx).
//
// Why on-device: no OpenAI account, no per-minute cost, text appears while the
// technician talks, and on phones that support it recognition works with no
// connection at all.
//
// LAZY NATIVE MODULE. expo-speech-recognition is a native module, so it only
// exists in a binary built after it was added. An OTA update reaching an older
// binary would otherwise throw at import and take the whole job screen down;
// instead `available` is false and the callers hide the mic.

type SpeechModule = typeof import("expo-speech-recognition");

let speechModule: SpeechModule | null | undefined;
function speech(): SpeechModule | null {
  if (speechModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      speechModule = require("expo-speech-recognition") as SpeechModule;
      speechModule.ExpoSpeechRecognitionModule.isRecognitionAvailable();
    } catch {
      speechModule = null;
    }
  }
  return speechModule;
}

// Biases recognition toward plumbing vocabulary so "RPZ" or "TMV" are less
// likely to come out as a homophone. Phrases only, no instructions — iOS and
// Android treat these as hints, not commands.
export const TRADE_TERMS = [
  "backflow", "RPZ valve", "reduced pressure zone", "testable", "non-testable",
  "double check valve", "air gap", "DN15", "DN20", "DN25", "DN32", "DN40", "DN50",
  "PRV", "pressure limiting valve", "TMV", "tempering valve", "thermostatic mixing valve",
  "floor waste", "gully trap", "inspection point", "vent stack", "cross-connection",
  "water hammer", "expansion valve", "isolation valve", "stop tap", "rough-in", "fit-off",
];

/** Joins recognised segments with single spaces. */
export function joinSegments(...parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
}

/** "wav" from "file:///…/recording_123.wav"; "m4a" when there is no usable extension. */
export function audioExtension(uri: string): string {
  const m = /\.([a-z0-9]{2,4})(?:[?#].*)?$/i.exec(uri);
  return m ? m[1].toLowerCase() : "m4a";
}

export interface DictationResult {
  text: string;
  /** Local recording, only when `persistAudio` was requested and the OS supports it (iOS, Android 13+). */
  audioUri: string | null;
}

export interface StartOptions {
  persistAudio?: boolean;
  /** Whether the phone is online. Offline, recognition is forced on-device where supported. */
  online: boolean;
}

// One recogniser per phone: the module is a singleton, so only the screen that
// started a session handles its events (two composers can be mounted at once).
let activeOwner: symbol | null = null;

export function useDictation(onDone: (result: DictationResult) => void) {
  const mod = speech();
  const owner = useRef(Symbol("dictation")).current;
  const committed = useRef("");
  const interim = useRef("");
  const audioUri = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mod) return;
    const m = mod.ExpoSpeechRecognitionModule;
    const mine = () => activeOwner === owner;
    const subs = [
      m.addListener("result", (e) => {
        if (!mine()) return;
        const said = e.results[0]?.transcript ?? "";
        if (e.isFinal) {
          committed.current = joinSegments(committed.current, said);
          interim.current = "";
        } else {
          interim.current = said;
        }
        setText(joinSegments(committed.current, interim.current));
      }),
      m.addListener("audioend", (e) => {
        if (mine()) audioUri.current = e.uri ?? null;
      }),
      m.addListener("error", (e) => {
        if (!mine()) return;
        // "no-speech" ends with empty text (handled at "end"); "aborted" is us.
        if (e.error === "no-speech" || e.error === "aborted") return;
        setError(
          e.error === "not-allowed"
            ? "Microphone or speech recognition permission is off. Enable it in Settings."
            : e.error === "network"
              ? "Couldn't reach the speech service. Check your connection, or type the note."
              : `Dictation stopped: ${e.message || e.error}`
        );
      }),
      m.addListener("end", () => {
        if (!mine()) return;
        activeOwner = null;
        setListening(false);
        const result = { text: joinSegments(committed.current, interim.current), audioUri: audioUri.current };
        onDoneRef.current(result);
      }),
    ];
    return () => {
      subs.forEach((s) => s.remove());
      if (mine()) {
        activeOwner = null;
        m.abort();
      }
    };
  }, [mod, owner]);

  const start = useCallback(
    async ({ persistAudio = false, online }: StartOptions): Promise<boolean> => {
      if (!mod) return false;
      const m = mod.ExpoSpeechRecognitionModule;
      setError(null);
      if (activeOwner) {
        setError("Dictation is already running on another note.");
        return false;
      }
      const perm = await m.requestPermissionsAsync();
      if (!perm.granted) {
        setError("Microphone or speech recognition permission is off. Enable it in Settings.");
        return false;
      }
      const onDevice = m.supportsOnDeviceRecognition();
      if (!online && !onDevice) {
        setError("This phone needs a connection for dictation. You can still type the note.");
        return false;
      }
      committed.current = "";
      interim.current = "";
      audioUri.current = null;
      setText("");
      activeOwner = owner;
      setListening(true);
      try {
        m.start({
          lang: "en-AU",
          interimResults: true,
          continuous: true,
          addsPunctuation: true,
          requiresOnDeviceRecognition: !online,
          contextualStrings: TRADE_TERMS,
          iosTaskHint: "dictation",
          ...(persistAudio ? { recordingOptions: { persist: true } } : {}),
        });
      } catch (e) {
        activeOwner = null;
        setListening(false);
        setError(e instanceof Error ? e.message : "Couldn't start dictation.");
        return false;
      }
      return true;
    },
    [mod, owner]
  );

  const stop = useCallback(() => {
    if (mod && activeOwner === owner) mod.ExpoSpeechRecognitionModule.stop();
  }, [mod, owner]);

  return { available: mod !== null, listening, text, error, start, stop };
}
