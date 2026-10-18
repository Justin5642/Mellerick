import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useAuth } from "../auth-context";

// Where tapping a notification should take the user, from its `data` payload.
// The server sends { type: "job_assigned", jobId } (migration 0077).
// Anything unrecognised opens nothing — the app simply comes to the front.
export function routeForNotification(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const jobId = (data as { jobId?: unknown }).jobId;
  if (typeof jobId === "string" && /^[0-9a-f-]{36}$/i.test(jobId)) return `/job/${jobId}`;
  return null;
}

// Opens the job a tapped notification is about. Covers both a tap while the app
// is running and the tap that launched it (useLastNotificationResponse returns
// that one on first render). Waits for a signed-in session: a tap that arrives
// before sign-in finishes is handled once it does, and one that arrives while
// signed out goes nowhere. Each response is handled once.
export function useNotificationTaps(): void {
  const response = Notifications.useLastNotificationResponse();
  const { session, loading } = useAuth();
  const router = useRouter();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!response || loading || !session) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const route = routeForNotification(response.notification.request.content.data);
    if (route) router.push(route as never);
  }, [response, loading, session, router]);
}
