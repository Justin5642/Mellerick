// Where the Supabase session (access + refresh token) lives on the phone.
//
// WHY NOT AsyncStorage. AsyncStorage is a plain, unencrypted file in the app
// sandbox. The refresh token in it is a long-lived credential for the whole
// account — anyone who can read the app's data (a device backup, a rooted or
// jailbroken handset, a forensic dump of a lost phone) can mint fresh sessions
// with it. The Keychain (iOS) and Keystore-encrypted prefs (Android) are what
// expo-secure-store wraps, and it was already a dependency, unused.
//
// FOUR THINGS MAKE THIS LESS SIMPLE THAN SWAPPING THE ADAPTER:
//
// 1. SIZE. SecureStore warns above ~2 KB per value and older Android releases
//    reject larger ones, while a Supabase session (two JWTs plus the user
//    object) is routinely 2-4 KB. Values are split into CHUNK_SIZE pieces.
//
// 2. ATOMICITY. A multi-chunk write is several native calls, and the app can be
//    killed between any two. Overwriting chunks in place would leave half an old
//    token and half a new one — unparseable, which supabase-js reads as "no
//    session": a technician logged out mid-shift by a token refresh. So each
//    write goes to FRESH chunk keys and only then flips a small manifest to
//    point at them; the manifest write is the commit, and a crash before it
//    leaves the previous session fully intact.
//
// 3. MIGRATION. Every existing install has its session in AsyncStorage. Reading
//    only SecureStore would log every user out the moment this update lands —
//    on a technician's phone, possibly offline, on a roof. A miss in SecureStore
//    therefore falls back to AsyncStorage, copies the value across, VERIFIES the
//    copy by reading it back, and only then deletes the plaintext original.
//
// 4. BACKGROUND TASKS. The auto-clock and background-sync tasks read the session
//    with the phone locked in a pocket. The Keychain's default accessibility is
//    "when unlocked", which would make every one of those reads fail. Values are
//    written AFTER_FIRST_UNLOCK: readable while locked, once the phone has been
//    unlocked since boot.
//
// 5. REINSTALLS. Keychain items survive uninstalling the app on iOS; the old
//    AsyncStorage session did not. Without care, deleting and reinstalling the
//    app would silently sign the previous person back in — on a phone that may
//    have been handed to someone else. A marker in AsyncStorage (which IS wiped
//    on uninstall) records that this install wrote the secure copy; a secure
//    session with no marker belongs to a previous install and is discarded.
//
// And it degrades rather than breaks: if the native module is missing (an OTA
// update reaching a binary built without it) or a SecureStore call throws, the
// adapter falls back to AsyncStorage — the previous behaviour — instead of
// losing the session.

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The subset of expo-secure-store this needs (injectable for tests). */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
  AFTER_FIRST_UNLOCK?: unknown;
}

/** AsyncStorage flag: this install has written the session to SecureStore. See (5). */
export const SECURE_SESSION_MARKER = "mellerick.secureSession.v1";

/** Comfortably under SecureStore's ~2048-byte guidance, even for multibyte text. */
export const CHUNK_SIZE = 1800;

interface Manifest {
  v: 1;
  gen: string;
  n: number;
}

function parseManifest(raw: string | null): Manifest | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    if (m && m.v === 1 && typeof m.gen === "string" && Number.isInteger(m.n) && m.n >= 0) return m as Manifest;
  } catch {
    // not a manifest
  }
  return null;
}

// SecureStore keys may contain only alphanumerics, ".", "-" and "_". Supabase's
// keys (sb-<ref>-auth-token, …-code-verifier) already comply; anything else is
// mapped rather than rejected.
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

const chunkKey = (key: string, gen: string, i: number) => `${safeKey(key)}.${gen}.${i}`;

function newGeneration(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the session storage adapter. `secure` is null when the native module
 * is unavailable, in which case this is AsyncStorage with extra steps.
 */
export function createSecureSessionStorage(secure: SecureStoreLike | null, legacy: KeyValueStorage): KeyValueStorage {
  const options = secure?.AFTER_FIRST_UNLOCK !== undefined ? { keychainAccessible: secure.AFTER_FIRST_UNLOCK } : {};

  // Writes to one key are serialized: supabase-js can save a refreshed session
  // while another save is still in flight, and two interleaved chunk writes are
  // exactly what the manifest exists to survive — but there is no reason to
  // invite them.
  const queues = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(work, work);
    queues.set(
      key,
      next.catch(() => {})
    );
    return next;
  }

  async function readSecure(key: string): Promise<string | null> {
    const manifest = parseManifest(await secure!.getItemAsync(safeKey(key), options));
    if (!manifest) return null;
    const parts: string[] = [];
    for (let i = 0; i < manifest.n; i++) {
      const part = await secure!.getItemAsync(chunkKey(key, manifest.gen, i), options);
      // A missing chunk means the store is damaged; report a miss so the
      // caller can fall back rather than hand supabase-js half a token.
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join("");
  }

  async function writeSecure(key: string, value: string): Promise<void> {
    const previous = parseManifest(await secure!.getItemAsync(safeKey(key), options));
    const gen = newGeneration();
    const n = Math.ceil(value.length / CHUNK_SIZE);
    for (let i = 0; i < n; i++) {
      await secure!.setItemAsync(chunkKey(key, gen, i), value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), options);
    }
    // THE COMMIT. Until this lands, readers still see the previous generation.
    await secure!.setItemAsync(safeKey(key), JSON.stringify({ v: 1, gen, n } satisfies Manifest), options);
    if (previous && previous.gen !== gen) await deleteChunks(key, previous);
  }

  async function deleteSecure(key: string): Promise<void> {
    const manifest = parseManifest(await secure!.getItemAsync(safeKey(key), options).catch(() => null));
    await secure!.deleteItemAsync(safeKey(key), options);
    if (manifest) await deleteChunks(key, manifest);
  }

  async function deleteChunks(key: string, manifest: Manifest): Promise<void> {
    for (let i = 0; i < manifest.n; i++) {
      try {
        await secure!.deleteItemAsync(chunkKey(key, manifest.gen, i), options);
      } catch {
        // An orphaned chunk is a few hundred bytes nothing reads; never fail a
        // session save over it.
      }
    }
  }

  return {
    async getItem(key) {
      if (!secure) return legacy.getItem(key);
      let stored: string | null = null;
      try {
        stored = await readSecure(key);
      } catch (e) {
        // Keychain unavailable (locked before first unlock, a restored backup
        // whose Keystore key did not travel). Fall through to the legacy copy if
        // there is one, rather than reporting "signed out".
        console.warn("[auth-storage] secure read failed; trying legacy storage:", e instanceof Error ? e.message : String(e));
        return legacy.getItem(key);
      }
      if (stored !== null) {
        if ((await legacy.getItem(SECURE_SESSION_MARKER)) === "1") return stored;
        // A previous install's session (see 5). Not this install's to use.
        await serialized(key, () => deleteSecure(key)).catch(() => {});
      }

      // MIGRATION: first read after the update.
      const old = await legacy.getItem(key);
      if (old === null) return null;
      try {
        await serialized(key, () => writeSecure(key, old));
        await legacy.setItem(SECURE_SESSION_MARKER, "1");
        // Delete the plaintext copy only once the secure copy reads back intact.
        if ((await readSecure(key)) === old) await legacy.removeItem(key);
      } catch (e) {
        // Keep using the legacy copy; the next read tries again.
        console.warn("[auth-storage] migration to secure storage failed; will retry:", e instanceof Error ? e.message : String(e));
      }
      return old;
    },

    async setItem(key, value) {
      if (!secure) return legacy.setItem(key, value);
      try {
        await serialized(key, () => writeSecure(key, value));
      } catch (e) {
        // Losing a refreshed token means a logout at the next launch. Keep the
        // session in the old place rather than not at all.
        console.warn("[auth-storage] secure write failed; saving to legacy storage:", e instanceof Error ? e.message : String(e));
        await legacy.setItem(key, value);
        // The secure copy is now OLDER than the legacy one, and reads prefer it.
        // An outdated refresh token is one Supabase has already rotated away —
        // using it signs the person out. Drop it so reads fall back.
        await serialized(key, () => deleteSecure(key)).catch(() => {});
        return;
      }
      await legacy.setItem(SECURE_SESSION_MARKER, "1");
      // A stale plaintext copy must not outlive the session it belonged to (it
      // would also be read back if SecureStore ever failed). Best-effort.
      await legacy.removeItem(key).catch(() => {});
    },

    async removeItem(key) {
      // Both places, always: a sign-out must clear the plaintext copy too.
      await legacy.removeItem(key).catch(() => {});
      if (!secure) return;
      await serialized(key, () => deleteSecure(key));
    },
  };
}

/**
 * expo-secure-store, or null when the native module is not in this binary.
 *
 * Guarded for the same reason as backgroundClockTask.ts's TaskManager require:
 * an OTA update can reach a build compiled without the module, and a throw at
 * import would take the whole app down instead of just this hardening.
 */
export function loadSecureStore(): SecureStoreLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("expo-secure-store") as SecureStoreLike;
    return typeof mod?.getItemAsync === "function" ? mod : null;
  } catch (e) {
    console.warn("[auth-storage] expo-secure-store unavailable — session stays in AsyncStorage for this build:", e);
    return null;
  }
}
