// Hand-maintained SQLite indexes for the device mirror.
//
// mobile/lib/powersync/schema.ts is GENERATED from sync-streams.yaml and the
// live column types, so an index typed into it by hand would vanish on the next
// regeneration. The generator (mobile/scripts/generate-powersync-schema.mjs)
// merges THIS map in instead, and refuses to run if an index names a table or
// column the streams do not sync.
//
// WHY THEY MATTER: PowerSync stores each synced table as JSON in one internal
// table and exposes a view over it. With no index, every `WHERE job_id = ?` or
// join in mobile/lib/data/reads/*.ts walks the whole table, parsing JSON for
// every row. These indexes are built on the same json_extract expressions the
// views use, so SQLite uses them for the view queries unchanged.
//
// ONE RULE: index what a local read actually filters or joins on — nothing
// speculative (each index costs write time on every sync). The lookups are
// enforced by mobile/lib/powersync/indexes.test.ts: a new `col = ?` lookup in a
// read without an index here fails that test.
//
// Format: table -> { indexName: [column, ...] }. Leading column = lookup key.
module.exports = {
  // listMyJobs (assigned_to = ?), countOtherScheduledJobs (assigned_to = ?
  // AND scheduled_start range); customer overview (customer_id = ?); office
  // lists and searches page newest-first (ORDER BY created_at DESC LIMIT).
  jobs: {
    assigned_scheduled: ['assigned_to', 'scheduled_start'],
    customer: ['customer_id'],
    created: ['created_at'],
  },
  // current_stage: correlated `WHERE n.job_id = j.id ORDER BY n.created_at
  // DESC LIMIT 1`, once per row of the office jobs list.
  job_stage_notes: { job_created: ['job_id', 'created_at'] },
  job_items: { job: ['job_id'] },
  job_variations: { job: ['job_id'] },
  job_expenses: { job: ['job_id'] },
  purchase_orders: { job: ['job_id'] },
  po_cost_centers: { po: ['po_id'] },
  equipment_usage_log: { job: ['job_id'], equipment_date: ['equipment_id', 'usage_date'] },
  equipment_expenses: { equipment: ['equipment_id'] },
  invoices: { customer: ['customer_id'], created: ['created_at'] },
  invoice_items: { invoice: ['invoice_id'] },
  quotes: { customer: ['customer_id'], created: ['created_at'] },
  quote_items: { quote: ['quote_id'] },
  sites: { customer: ['customer_id'] },
  backflow_tests: { device: ['device_id'] },
  // lib/location-tracking.tsx findOpenEntry: job_id = ? AND staff_id = ?;
  // clock.ts SQL_LATEST_OPEN_WORK_ENTRY: staff_id = ? (any job).
  time_entries: { job_staff: ['job_id', 'staff_id'], staff: ['staff_id'] },
  // Crew membership (reads/assignedJobs.ts): `j.id IN (SELECT job_id FROM
  // job_assignments WHERE staff_id = ?)` in my-jobs lists and schedule counts.
  job_assignments: { staff: ['staff_id'] },
  // reads/jobPhotos.ts: job_id = ?
  job_photos: { job: ['job_id'] },
};
