// Dummy Supabase env so modules that read process.env at import/call time
// (e.g. route handlers via lib/supabase/*) don't throw during unit tests.
// No real network calls happen — the Supabase seams are mocked per-test.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://unit-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "unit-test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "unit-test-service-role-key";
