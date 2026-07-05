"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function EditCustomerPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    mobile: "",
    company: "",
    abn: "",
    notes: "",
    is_active: true,
  });

  useEffect(() => {
    async function load() {
      const { data: customer, error } = await supabase.from("customers").select("*").eq("id", id).single();
      if (error || !customer) {
        toast.error("Could not load customer");
        router.push("/dashboard/customers");
        return;
      }
      setForm({
        name: customer.name ?? "",
        email: customer.email ?? "",
        phone: customer.phone ?? "",
        mobile: customer.mobile ?? "",
        company: customer.company ?? "",
        abn: customer.abn ?? "",
        notes: customer.notes ?? "",
        is_active: customer.is_active ?? true,
      });
      setFetching(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase
      .from("customers")
      .update({
        name: form.name,
        email: form.email,
        phone: form.phone,
        mobile: form.mobile,
        company: form.company,
        abn: form.abn,
        notes: form.notes,
        is_active: form.is_active,
      })
      .eq("id", id);
    if (error) {
      toast.error(error.message);
      setLoading(false);
    } else {
      toast.success("Customer updated");
      router.push(`/dashboard/customers/${id}`);
      router.refresh();
    }
  }

  if (fetching) {
    return <div className="p-6 text-slate-400 text-sm">Loading...</div>;
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/dashboard/customers/${id}`}>
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Edit Customer</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customer Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Full Name *</Label>
                <Input id="name" value={form.name} onChange={(e) => set("name", e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="company">Company</Label>
                <Input id="company" value={form.company} onChange={(e) => set("company", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mobile">Mobile</Label>
                <Input id="mobile" value={form.mobile} onChange={(e) => set("mobile", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="abn">ABN</Label>
                <Input id="abn" value={form.abn} onChange={(e) => set("abn", e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="is_active"
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((prev) => ({ ...prev, is_active: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300"
              />
              <Label htmlFor="is_active" className="cursor-pointer">
                Active customer
              </Label>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href={`/dashboard/customers/${id}`}>
            <Button variant="outline" type="button">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={loading}>
            {loading ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}
