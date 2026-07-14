"use client";

// Last-resort boundary -- only fires if the root layout itself throws
// (app/error.tsx can't catch that, per Next.js: it's scoped below the root
// layout). Deliberately self-contained with inline styles and no imports
// from the rest of the app (no Tailwind classes, no shared components) --
// if the root layout is broken, we don't want this fallback depending on
// anything that might be broken along with it.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f8fafc" }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 380, width: "100%", textAlign: "center" }}>
            <h1 style={{ fontSize: 18, fontWeight: 600, color: "#0f172a", marginBottom: 8 }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: 14, color: "#64748b", marginBottom: 20 }}>
              The app hit an unexpected error and couldn&apos;t recover on its own. Try reloading the page.
            </p>
            <button
              onClick={() => reset()}
              style={{
                background: "#2563eb",
                color: "white",
                border: "none",
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
