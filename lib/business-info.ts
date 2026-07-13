// Business letterhead details used on generated quote/invoice PDFs and outgoing emails.
// Update these with your real details (or set the matching env vars on Vercel to override).
export const businessInfo = {
  name: process.env.BUSINESS_NAME || "Mellerick Pty Ltd",
  abn: process.env.BUSINESS_ABN || "65 603 386 947",
  address: process.env.BUSINESS_ADDRESS || "21 Quinlan Rd, Epping VIC 3076",
  phone: process.env.BUSINESS_PHONE || "0417 139 560",
  email: process.env.BUSINESS_EMAIL || "admin@mellerick.com",
};
