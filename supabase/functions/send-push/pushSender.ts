// Pure, runtime-agnostic Expo-push dispatch logic (no Deno/Node specifics, fetch
// injected) so it is unit-testable with vitest. The Deno Edge Function in
// index.ts is a thin wrapper: authorize → read device_tokens → call this.

export interface PushNotification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface SendResult {
  sent: number;
  failed: number;
  invalidTokens: string[]; // DeviceNotRegistered — caller should delete these
  errors: string[];
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_PER_REQUEST = 100; // Expo accepts up to 100 messages per call

export function chunk<T>(items: T[], size = MAX_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Only well-formed Expo tokens are messaged; anything else is dropped up front.
export function buildMessages(tokens: string[], n: PushNotification): ExpoMessage[] {
  return tokens
    .filter((t) => typeof t === "string" && (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken[")))
    .map((to) => ({ to, title: n.title, body: n.body, ...(n.data ? { data: n.data } : {}) }));
}

// POST the messages to Expo in batches. `fetchFn` is injected (global fetch in
// Deno/modern Node) so this is fully testable. Never throws — network/HTTP
// failures are collected into `errors`. Surfaces DeviceNotRegistered tokens so
// the caller can prune dead rows from device_tokens.
export async function sendExpoPush(
  fetchFn: typeof fetch,
  tokens: string[],
  notification: PushNotification
): Promise<SendResult> {
  const messages = buildMessages(tokens, notification);
  const result: SendResult = { sent: 0, failed: 0, invalidTokens: [], errors: [] };
  if (messages.length === 0) return result;

  for (const batch of chunk(messages)) {
    let res: Response;
    try {
      res = await fetchFn(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(batch),
      });
    } catch (e) {
      result.failed += batch.length;
      result.errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    if (!res.ok) {
      result.failed += batch.length;
      result.errors.push(`HTTP ${res.status}`);
      continue;
    }
    let json: { data?: Array<{ status: string; message?: string; details?: { error?: string } }> };
    try {
      json = await res.json();
    } catch {
      result.failed += batch.length;
      result.errors.push("invalid JSON from Expo");
      continue;
    }
    (json.data ?? []).forEach((ticket, i) => {
      if (ticket.status === "ok") {
        result.sent++;
      } else {
        result.failed++;
        if (ticket.details?.error === "DeviceNotRegistered") result.invalidTokens.push(batch[i].to);
        if (ticket.message) result.errors.push(ticket.message);
      }
    });
  }
  return result;
}
