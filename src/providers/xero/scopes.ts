export const xeroScopes: Readonly<Record<string, string>> = {
  settingsRead: "accounting.settings.read",
  contactsRead: "accounting.contacts.read",
  contactsWrite: "accounting.contacts",
  invoicesRead: "accounting.invoices.read",
  invoicesWrite: "accounting.invoices",
  paymentsRead: "accounting.payments.read",
  bankTransactionsRead: "accounting.banktransactions.read",
  bankSummaryRead: "accounting.reports.banksummary.read",
  profitAndLossRead: "accounting.reports.profitandloss.read",
  balanceSheetRead: "accounting.reports.balancesheet.read",
  trialBalanceRead: "accounting.reports.trialbalance.read",
  agedReportsRead: "accounting.reports.aged.read",
  cashValidationRead: "finance.cashvalidation.read",
  bankStatementsPlusRead: "finance.bankstatementsplus.read",
};

export const xeroDefaultCustomConnectionScopes: readonly string[] = [
  xeroScopes.settingsRead,
  xeroScopes.contactsWrite,
  xeroScopes.invoicesWrite,
  xeroScopes.paymentsRead,
  xeroScopes.bankTransactionsRead,
  xeroScopes.bankSummaryRead,
  xeroScopes.profitAndLossRead,
  xeroScopes.balanceSheetRead,
  xeroScopes.trialBalanceRead,
  xeroScopes.agedReportsRead,
];
