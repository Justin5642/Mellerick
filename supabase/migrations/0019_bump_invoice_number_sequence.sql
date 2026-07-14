-- Xero has its own long-running plain-numeric invoice sequence (already at
-- 27336 as of writing) from before this app existed, completely independent
-- of our own invoices.invoice_number serial (which only reached #2). Left
-- alone, newly created invoices here would collide with -- or just look
-- nothing like -- Xero's real numbering once pushed. Bump our sequence to
-- continue immediately after Xero's current max so the two stay aligned
-- going forward (app/api/xero/push-invoice/route.ts now also sends this
-- number explicitly as Xero's InvoiceNumber on push, instead of letting
-- Xero auto-assign its own).
SELECT setval(pg_get_serial_sequence('invoices', 'invoice_number'), 27336, true);
