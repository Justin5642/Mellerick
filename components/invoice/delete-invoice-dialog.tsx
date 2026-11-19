"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { formatInvoiceNumber } from "@/lib/utils";
import { DELETE_IN_XERO_WARNING, deleteInvoiceMessage } from "@/lib/invoice-actions";

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

// Admin only: DELETE /api/invoices/[id] (requireAdmin; the phone uses it too).
// Deleting an invoice cascades (at the database level) to its invoice_items
// (invoice_items.invoice_id is "on delete cascade"). Any job variation linked
// to this invoice has its invoice_id set back to null (migration 0011 uses
// "on delete set null"), so the variation itself survives and simply becomes
// un-invoiced again.
export function DeleteInvoiceDialog({ invoiceId, invoiceNumber, invoiceTitle, inXero, open, onOpenChange }: Props) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "The invoice could not be deleted. Please try again.");
      toast.success("Invoice deleted");
      router.push("/dashboard/invoices");
    } catch (e: any) {
      toast.error(e.message ?? "The invoice could not be deleted. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete invoice {formatInvoiceNumber(invoiceNumber)}?</DialogTitle>
          <DialogDescription>
            {deleteInvoiceMessage(invoiceTitle, false)}
            {inXero && (
              <>
                {" "}
                <span className="text-amber-700 font-medium">{DELETE_IN_XERO_WARNING}</span>
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
