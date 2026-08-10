import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/lib/database.types'

// Typed against lib/database.types.ts (item 3.3), which is generated from the
// database and kept honest by tests/unit/database-types-freshness.test.ts.
//
// This is the whole point of generating them: a column name that does not exist
// stops COMPILING instead of failing at runtime. It has already paid for itself
// — it flagged a write payload whose TYPE permitted `vehicle_cost_per_hour`, a
// derived value that is deliberately not a column on staff_cost_profiles.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
