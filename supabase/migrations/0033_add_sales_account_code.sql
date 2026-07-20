-- =============================================
-- XERO SALES ACCOUNT CODE
-- Run this once in the Supabase SQL editor.
--
-- Purpose: invoice line items pushed to Xero were hardcoded to account code
-- '200', which is archived/deleted in this org's chart of accounts, so EVERY
-- invoice push was rejected ("Account code '200' has been archived..."). Make
-- the sales/income account code office-configurable (same pattern as the
-- existing default_expense_account_code for Bills) so an archived account
-- can't silently break every push again. Backfilled to '230', the org's
-- current sales account.
--
-- Additive with a default -- safe to re-run.
-- =============================================

alter table xero_tokens add column if not exists default_sales_account_code text default '230';

comment on column xero_tokens.default_sales_account_code is
  'Chart-of-accounts code that invoice line items post revenue to when pushed to Xero as an ACCREC invoice. Office-configurable in Settings; defaults to 230.';

-- Backfill the existing single connected org (the column default only applies
-- to new rows, and there's already one token row from the OAuth connect).
update xero_tokens set default_sales_account_code = '230' where default_sales_account_code is null;
