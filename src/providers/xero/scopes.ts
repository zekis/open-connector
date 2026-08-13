export const xeroScopes: Readonly<Record<string, string>> = {
  settingsRead: "accounting.settings.read",
  contactsRead: "accounting.contacts.read",
  contactsWrite: "accounting.contacts",
  invoicesRead: "accounting.invoices.read",
  invoicesWrite: "accounting.invoices",
};

export const xeroDefaultCustomConnectionScopes: readonly string[] = [
  xeroScopes.settingsRead,
  xeroScopes.contactsWrite,
  xeroScopes.invoicesWrite,
];
