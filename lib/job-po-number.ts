// The number for a new cost-centre purchase order on a job, so the office
// never has to make one up (Justin, 29 Oct 2026: "Maybe job number. And then
// -1, -2, and so on"). Job 4321's POs are 4321-1, 4321-2, ...
//
// Next after the highest already used, not the count: delete 4321-1 out of
// 4321-1 and 4321-2 and the next is still 4321-3, never a second 4321-2.
// Numbers in any other shape (Simpro's "SIMPRO-2816", one typed by hand) are
// ignored.
export function nextJobPoNumber(jobNumber: number | string, existing: string[]): string {
  const prefix = `${jobNumber}-`;
  let highest = 0;
  for (const n of existing) {
    const t = n.trim();
    if (!t.startsWith(prefix)) continue;
    const rest = t.slice(prefix.length);
    if (/^\d+$/.test(rest)) highest = Math.max(highest, Number(rest));
  }
  return `${prefix}${highest + 1}`;
}
