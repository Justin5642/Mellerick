import { XeroClient } from "xero-node";

export function getXeroClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID!,
    clientSecret: process.env.XERO_CLIENT_SECRET!,
    redirectUris: [process.env.XERO_REDIRECT_URI!],
    scopes: ["openid", "profile", "email", "accounting.contacts", "accounting.invoices", "offline_access"],
    httpTimeout: 30000,
  });
}
