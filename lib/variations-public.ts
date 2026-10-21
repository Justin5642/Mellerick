// Variations as a technician may see them: from the rate-stripped views
// (migration 0028 — variation_types_public, job_variations_public), never the
// priced base tables. Those are office/admin-only under RLS, so a tech reading
// them gets nothing — the web Variations tab used to, and showed an empty list
// with no types to pick (Justin, 21 Oct 2026: "we definitely don't want them
// seeing any pricing").
//
// Views carry no foreign keys for PostgREST to embed through, so the type name
// and the logger's name are joined here, in the same shape the page expects.

type Client = { from: (table: string) => any };

export async function loadTechVariations(
  supabase: Client,
  filter: { jobId: string } | { id: string }
): Promise<{ data: any[]; error: string | null }> {
  let q = supabase.from("job_variations_public").select("*");
  q = "jobId" in filter ? q.eq("job_id", filter.jobId) : q.eq("id", filter.id);
  const { data: rows, error } = await q.order("created_at", { ascending: false });
  if (error) return { data: [], error: error.message };
  const list = (rows ?? []) as any[];
  if (list.length === 0) return { data: [], error: null };

  const typeIds = [...new Set(list.map((v) => v.variation_type_id).filter(Boolean))];
  const staffIds = [...new Set(list.map((v) => v.logged_by).filter(Boolean))];
  const [types, staff] = await Promise.all([
    typeIds.length ? supabase.from("variation_types_public").select("id, name").in("id", typeIds) : { data: [] },
    staffIds.length ? supabase.from("profiles").select("id, full_name").in("id", staffIds) : { data: [] },
  ]);
  const typeName = new Map<string, string>(((types.data ?? []) as any[]).map((t) => [t.id, t.name]));
  const staffName = new Map<string, string>(((staff.data ?? []) as any[]).map((p) => [p.id, p.full_name]));

  return {
    data: list.map((v) => ({
      ...v,
      variation_types: v.variation_type_id && typeName.has(v.variation_type_id) ? { name: typeName.get(v.variation_type_id) } : null,
      profiles: v.logged_by && staffName.has(v.logged_by) ? { full_name: staffName.get(v.logged_by) } : null,
    })),
    error: null,
  };
}
