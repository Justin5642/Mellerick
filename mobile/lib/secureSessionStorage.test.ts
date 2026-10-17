import { CHUNK_SIZE, SECURE_SESSION_MARKER, createSecureSessionStorage, type KeyValueStorage, type SecureStoreLike } from "./secureSessionStorage";

// The session moves from plaintext AsyncStorage to the Keychain/Keystore. The
// tests that matter most are the ones about NOT signing anybody out: the
// migration, a write that dies half-way, and a secure store that fails.

const KEY = "sb-proj-auth-token";

function memory(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

function fakeSecure(): SecureStoreLike & { data: Map<string, string>; failWrites: number | null; options: object[] } {
  const data = new Map<string, string>();
  const s = {
    data,
    failWrites: null as number | null, // fail once this many writes have succeeded
    options: [] as object[],
    AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
    getItemAsync: jest.fn(async (k: string) => data.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string, o?: object) => {
      if (s.failWrites !== null) {
        if (s.failWrites === 0) throw new Error("keychain write failed");
        s.failWrites--;
      }
      if (/[^A-Za-z0-9._-]/.test(k)) throw new Error(`invalid key ${k}`);
      s.options.push(o ?? {});
      data.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => void data.delete(k)),
  };
  return s;
}

// A realistic session is well over SecureStore's ~2 KB per-value guidance.
const SESSION = JSON.stringify({ access_token: "a".repeat(2500), refresh_token: "r".repeat(40), user: { id: "u1" } });

describe("createSecureSessionStorage", () => {
  it("round-trips a session larger than one SecureStore value, in chunks", async () => {
    const secure = fakeSecure();
    const store = createSecureSessionStorage(secure, memory());
    await store.setItem(KEY, SESSION);
    expect(await store.getItem(KEY)).toBe(SESSION);
    for (const v of secure.data.values()) expect(v.length).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it("writes Keychain items readable after first unlock — background tasks read the session while the phone is locked", async () => {
    const secure = fakeSecure();
    await createSecureSessionStorage(secure, memory()).setItem(KEY, SESSION);
    expect(secure.options.every((o) => (o as { keychainAccessible?: unknown }).keychainAccessible === "AFTER_FIRST_UNLOCK")).toBe(true);
  });

  it("MIGRATES an existing AsyncStorage session on first read — nobody is signed out by the update", async () => {
    const secure = fakeSecure();
    const legacy = memory();
    legacy.data.set(KEY, SESSION);
    const store = createSecureSessionStorage(secure, legacy);
    expect(await store.getItem(KEY)).toBe(SESSION);
    // Now in the secure store, and the plaintext copy is gone.
    expect(legacy.data.has(KEY)).toBe(false);
    expect(await createSecureSessionStorage(secure, legacy).getItem(KEY)).toBe(SESSION);
  });

  it("keeps the plaintext copy (and the session) when the migration write fails", async () => {
    const secure = fakeSecure();
    secure.failWrites = 1;
    const legacy = memory();
    legacy.data.set(KEY, SESSION);
    const store = createSecureSessionStorage(secure, legacy);
    expect(await store.getItem(KEY)).toBe(SESSION);
    expect(legacy.data.get(KEY)).toBe(SESSION);
  });

  it("a write that dies half-way leaves the PREVIOUS session readable, never a mix", async () => {
    const secure = fakeSecure();
    const legacy = memory();
    const store = createSecureSessionStorage(secure, legacy);
    await store.setItem(KEY, SESSION);
    const refreshed = SESSION.replace(/a/g, "b");
    secure.failWrites = 1; // first chunk lands, second throws — the app "dies"
    await store.setItem(KEY, refreshed); // falls back to legacy
    // Reads must return a whole session: the refreshed one (from the fallback),
    // never half of each.
    const read = await store.getItem(KEY);
    expect([SESSION, refreshed]).toContain(read);
    expect(read).toBe(refreshed);
  });

  it("a process killed mid-write (no fallback reached) still reads the previous session whole", async () => {
    const secure = fakeSecure();
    const legacy = memory();
    const store = createSecureSessionStorage(secure, legacy);
    await store.setItem(KEY, SESSION);
    secure.failWrites = 1; // one new chunk lands, then the "crash"
    legacy.setItem = async () => {
      throw new Error("process killed");
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(store.setItem(KEY, SESSION.replace(/a/g, "z"))).rejects.toThrow();
    warn.mockRestore();
    // The manifest — the commit point — still names the old generation.
    expect(await createSecureSessionStorage(secure, legacy).getItem(KEY)).toBe(SESSION);
  });

  it("falls back to AsyncStorage when the secure store cannot be read", async () => {
    const secure = fakeSecure();
    (secure.getItemAsync as jest.Mock).mockRejectedValue(new Error("User interaction is not allowed"));
    const legacy = memory();
    legacy.data.set(KEY, SESSION);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await createSecureSessionStorage(secure, legacy).getItem(KEY)).toBe(SESSION);
    warn.mockRestore();
  });

  it("removeItem clears both places — a sign-out leaves no plaintext copy", async () => {
    const secure = fakeSecure();
    const legacy = memory();
    const store = createSecureSessionStorage(secure, legacy);
    await store.setItem(KEY, SESSION);
    legacy.data.set(KEY, "stale");
    await store.removeItem(KEY);
    expect(await store.getItem(KEY)).toBeNull();
    expect(legacy.data.has(KEY)).toBe(false);
    expect([...secure.data.keys()]).toEqual([]);
  });

  it("does not leave old chunks behind across refreshes", async () => {
    const secure = fakeSecure();
    const store = createSecureSessionStorage(secure, memory());
    await store.setItem(KEY, SESSION);
    const after1 = secure.data.size;
    await store.setItem(KEY, SESSION.replace(/a/g, "c"));
    expect(secure.data.size).toBe(after1);
  });

  it("ignores a Keychain session left by a PREVIOUS install (iOS keeps Keychain items across uninstall)", async () => {
    const secure = fakeSecure();
    const oldInstall = memory();
    await createSecureSessionStorage(secure, oldInstall).setItem(KEY, SESSION);
    expect(oldInstall.data.get(SECURE_SESSION_MARKER)).toBe("1");
    // Reinstall: AsyncStorage is wiped, the Keychain is not.
    const freshInstall = memory();
    const store = createSecureSessionStorage(secure, freshInstall);
    expect(await store.getItem(KEY)).toBeNull();
    expect(secure.data.size).toBe(0);
  });

  it("maps keys SecureStore would reject", async () => {
    const secure = fakeSecure();
    const store = createSecureSessionStorage(secure, memory());
    await store.setItem("sb:weird/key", "v");
    expect(await store.getItem("sb:weird/key")).toBe("v");
  });

  it("is plain AsyncStorage when the native module is unavailable", async () => {
    const legacy = memory();
    const store = createSecureSessionStorage(null, legacy);
    await store.setItem(KEY, SESSION);
    expect(legacy.data.get(KEY)).toBe(SESSION);
    expect(await store.getItem(KEY)).toBe(SESSION);
  });
});
