// Mirror of lib/invoice-actions.ts for the phone: the words of Push / Update in Xero and Delete on the invoice screen.
// Everything below the first blank line is byte-identical to the web file
// (pinned by tests/unit/invoice-phone-mirrors.test.ts) — change the web file
// first, then copy its body here.

/** The delete confirm's body. An invoice in Xero stays there — say so. */
export function deleteInvoiceMessage(title: string, inXero: boolean): string {
  const base =
    `This permanently deletes “${title}” and all of its line items. Any variations that were ` +
    "billed on it become un-invoiced again. This can't be undone.";
  return inXero ? `${base} ${DELETE_IN_XERO_WARNING}` : base;
}

export const DELETE_IN_XERO_WARNING =
  "This invoice was pushed to Xero — deleting it here does NOT remove it from Xero. Void or delete it " +
  "in Xero separately, or the two will be out of sync.";

/** What the push button says. */
export function pushToXeroLabel(pushed: boolean, pushing: boolean): string {
  if (pushed) return pushing ? "Updating..." : "Update in Xero";
  return pushing ? "Pushing to Xero..." : "Push to Xero";
}

/** Asked before pushing when the job has hours not priced on the invoice. */
export function unpricedPushConfirm(unpricedHours: number): string {
  return (
    `${unpricedHours.toFixed(2)}h on this job have not been priced on this invoice. ` +
    `Push to Xero without them? (Use "Apply hourly rate" below to bill them.)`
  );
}

/** The answer once Xero has it. */
export function pushedMessage(updated: boolean): string {
  return updated ? "Invoice updated in Xero" : "Invoice pushed to Xero successfully";
}

/** When the push route answers without a reason. */
export function pushFailedMessage(pushed: boolean): string {
  return pushed ? "Failed to update in Xero" : "Failed to push to Xero";
}
