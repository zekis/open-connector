export interface XeroApiFamilyDefinition {
  baseUrl: string;
  description: string;
}

/** Fixed Xero API bases available to the generic read-only retrieval action. */
export const xeroApiFamilies: Readonly<Record<string, XeroApiFamilyDefinition>> = {
  accounting: {
    baseUrl: "https://api.xero.com/api.xro/2.0",
    description: "Accounting resources, transactions, settings, reports, contacts, and attachments.",
  },
  assets: {
    baseUrl: "https://api.xero.com/assets.xro/1.0",
    description: "Fixed assets, asset types, and asset settings.",
  },
  files: {
    baseUrl: "https://api.xero.com/files.xro/1.0",
    description: "Files, folders, file content, and associations.",
  },
  projects: {
    baseUrl: "https://api.xero.com/projects.xro/2.0",
    description: "Projects, tasks, time entries, expenses, and project users.",
  },
  payroll_au: {
    baseUrl: "https://api.xero.com/payroll.xro/1.0",
    description: "Australian payroll resources.",
  },
  payroll_nz: {
    baseUrl: "https://api.xero.com/payroll.xro/2.0",
    description: "New Zealand payroll resources.",
  },
  payroll_uk: {
    baseUrl: "https://api.xero.com/payroll.xro/2.0",
    description: "United Kingdom payroll resources.",
  },
  finance: {
    baseUrl: "https://api.xero.com/finance.xro",
    description: "Partner-only Finance API resources.",
  },
  bank_feeds: {
    baseUrl: "https://api.xero.com/bankfeeds.xro/1.0",
    description: "Partner-only bank feed connections and statements.",
  },
  einvoicing: {
    baseUrl: "https://api.xero.com/einvoicing.xro/1.0",
    description: "Partner-only eInvoicing registrations.",
  },
  app_store: {
    baseUrl: "https://api.xero.com/appstore/2.0",
    description: "Xero App Store subscriptions and metered billing.",
  },
};

export const xeroApiFamilyNames: readonly string[] = Object.keys(xeroApiFamilies);
