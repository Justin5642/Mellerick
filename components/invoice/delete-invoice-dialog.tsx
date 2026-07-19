"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { formatInvoiceNumber } from "@/lib/utils";

interface Props {
  invoiceId: string;
  invoiceNumber: number;
  invoiceTitle: string;
  // Set when this invoice has already been pushed to Xero — deleting here only
  // removes the local copy, the Xero invoice stays and must be voided there.
  inXero: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Deleting an invoice cascades (at the database level) to its invoice_items
// (invoice_items.invoice_id is "on delete cascade"). Any job variation linked
// to this invoice has its invoice_id set back to null (migration 0011 uses
// "on delete set null"), so the variation itself survives and simply becomes
// un-invoiced again. Nothing else references invoices(id), so the delete can't
// be blocked by a foreign key.
export function DeleteInvoiceDialog({ invoiceId, invoiceNumber, invoiceTitle, inXero, open, onOpenChange }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    const { error } = await supabase.from("invoices").delete().eq("id", invoiceId);
    if (error) {
      toast.error(error.message);
      setDeleting(false);
      return;
    }
    toast.success("Invoice deleted");
    router.push("/dashboard/invoices");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete invoice {formatInvoiceNumber(invoiceNumber)}?</DialogTitle>
          <DialogDescription>
            This permanently deletes &ldquo;{invoiceTitle}&rdquo; and all of its line items. Any variations that were
            billed on it become un-invoiced again. This can&apos;t be undone.
            {inXero && (
              <>
                {" "}
                <span className="text-amber-700 font-medium">
                  This invoice was pushed to Xero — deleting it here does NOT remove it from Xero. Void or delete it
                  in Xero separately, or the two will be out of sync.
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>Cancel</Button>
          <Button variant="destructive" className="gap-2" onClick={handleDelete} disabled={deleting}>
            <Trash2 className="w-4 h-4" />{deleting ? "Deleting..." : "Delete Invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
