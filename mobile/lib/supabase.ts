import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { assertMobileEnv } from "./env";

// Throws immediately if the build shipped without credentials. The `!` below
// used to be the only "check": it satisfies TypeScript and does nothing at
// runtime, so a missing value produced createClient(undefined, undefined) — an
// app that launches and renders and then fails every request with errors that
// point at the network rather than at the configuration.
assertMobileEnv(process.env as Record<string, string | undefined>);

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
