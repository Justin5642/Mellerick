import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", user.id)
    .single();

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <AppSidebar
        userEmail={user.email}
        userName={profile?.full_name}
        userRole={profile?.role}
      />
      {/* Clears the fixed mobile top bar rendered by AppSidebar below md --
          its actual height is the 56px bar plus whatever safe-area clearance
          it added up top (real inset if the browser reports one, 44px floor
          otherwise -- see the detailed comment in app-sidebar.tsx on why a
          floor is needed even in a regular Safari tab). Desktop has no top
          bar so no offset needed there. */}
      <main className="flex-1 overflow-y-auto pt-[calc(max(env(safe-area-inset-top),44px)+3.5rem)] md:pt-0">
        {children}
      </main>
      {/* Faint brand watermark, pinned to the bottom-right corner of the
          viewport so it stays put while pages scroll and never collides
          with the sidebar. Non-interactive — purely decorative. */}
      <div
        aria-hidden
        className="pointer-events-none select-none fixed bottom-0 right-0 z-0 opacity-[0.06]"
      >
        <img src="/logo.png" alt="" className="w-[420px] max-w-[40vw]" />
      </div>
    </div>
  );
}
