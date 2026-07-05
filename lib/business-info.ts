// Business letterhead details used on generated quote/invoice PDFs and outgoing emails.
// Update these with your real details (or set the matching env vars on Vercel to override).
export const businessInfo = {
  name: process.env.BUSINESS_NAME || "Mellerick Plumbing and Drainage",
  abn: process.env.BUSINESS_ABN || "",
  address: process.env.BUSINESS_ADDRESS || "",
  phone: process.env.BUSINESS_PHONE || "",
  email: process.env.BUSINESS_EMAIL || "",
};
