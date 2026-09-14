import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { assertMobileEnv } from "./env";

// Throws immediately if the build shipped without credentials. The `!` below
// used to be the only "check": it satisfies TypeScript and does nothing at
// runtime, so a missing value produced createClient(undefined, undefined) — an
// app that launches and renders and then fails every request with errors that
// point at the network rather than at the configuration.
//
// Each property below must be a static `process.env.EXPO_PUBLIC_*` access —
// that's the only pattern Expo's babel plugin inlines to a literal at build
// time. Passing the bare `process.env` object (as this used to do) hands
// assertMobileEnv a live runtime object that React Native never populates,
// so it threw on every build regardless of what EAS env vars were set.
assertMobileEnv({
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
