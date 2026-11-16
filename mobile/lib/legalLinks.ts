// Links to the public privacy policy and account-deletion pages on the office
// web app (app/privacy, app/delete-account at the repo root).
//
// App Review guideline 5.1.1(i): the privacy policy must be reachable from
// INSIDE the app, not only from the App Store Connect field. Accounts are
// created by the office (no sign-up in the app), so deletion is a request to
// the office, which the delete-account page explains (5.1.1(v)).
//
// The production origin is the fallback, not EXPO_PUBLIC_API_BASE_URL alone:
// that variable is optional (see SHIPPING.md), and a policy link that opens
// "undefined/privacy" is exactly what a reviewer would tap.
export const PRODUCTION_WEB_ORIGIN = "https://mellerick-app.vercel.app";

export function webOrigin(apiBaseUrl: string | undefined = process.env.EXPO_PUBLIC_API_BASE_URL): string {
  const base = (apiBaseUrl ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\//.test(base) ? base : PRODUCTION_WEB_ORIGIN;
}

export function privacyPolicyUrl(apiBaseUrl?: string): string {
  return `${webOrigin(apiBaseUrl)}/privacy`;
}

export function deleteAccountUrl(apiBaseUrl?: string): string {
  return `${webOrigin(apiBaseUrl)}/delete-account`;
}
