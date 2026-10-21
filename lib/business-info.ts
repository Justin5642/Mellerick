// Business letterhead details used on generated quote/invoice PDFs and outgoing emails.
// Update these with your real details (or set the matching env vars on Vercel to override).
export const businessInfo = {
  name: process.env.BUSINESS_NAME || "Mellerick Pty Ltd",
  abn: process.env.BUSINESS_ABN || "65 603 386 947",
  address: process.env.BUSINESS_ADDRESS || "21 Quinlan Rd, Epping VIC 3076",
  phone: process.env.BUSINESS_PHONE || "0417 139 560",
  email: process.env.BUSINESS_EMAIL || "admin@mellerick.com",
  // "How To Pay" on invoices — as on the Simpro invoices (INV 27650).
  bank: {
    bank: process.env.BUSINESS_BANK_NAME || "Bendigo Bank",
    accountName: process.env.BUSINESS_BANK_ACCOUNT_NAME || "Mellerick Pty Ltd",
    bsb: process.env.BUSINESS_BANK_BSB || "633 000",
    accountNumber: process.env.BUSINESS_BANK_ACCOUNT_NUMBER || "167 831 189",
  },
};
