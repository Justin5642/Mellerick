"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Settings → Email: send a sample invoice email to check delivery and replies. */
export function EmailTestButton() {
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    setSending(true);
    try {
      const res = await fetch("/api/email/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Test failed (${res.status})`);
      toast.success(`Test invoice sent to ${data.to}. Check it arrived, then reply to it.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    }
    setSending(false);
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input
        type="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="An outside address, e.g. your Gmail"
        className="sm:max-w-xs"
      />
      <Button type="button" variant="outline" className="gap-2" onClick={send} disabled={sending || !to.trim()}>
        <Send className="h-4 w-4" />
        {sending ? "Sending..." : "Send test invoice"}
      </Button>
    </div>
  );
}
