import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { xeroApiFamilies, xeroApiFamilyNames } from "./api-families.ts";
import { xeroScopes } from "./scopes.ts";

const service = "xero";

const noInputSchema = s.object("No input is required.", {});
const pageSchema = s.positiveInteger("Page number to return.");
const pageSizeSchema = s.positiveInteger("Number of records to return per page.");
const xeroApiFamilyDescription = xeroApiFamilyNames
  .map((name) => `${name}: ${xeroApiFamilies[name]!.description}`)
  .join(" ");

const retrievalResponseSchema = s.object(
  "Raw response from a Xero retrieval endpoint.",
  {
    status: s.integer("HTTP status returned by Xero."),
    headers: s.record(s.string("Response header value."), {
      description: "Response headers, including Xero request and rate-limit metadata.",
    }),
    data: s.unknown("Parsed JSON, text, or base64-encoded binary response data."),
    bodyEncoding: s.stringEnum("Encoding applied to binary response data.", ["base64"]),
  },
  { optional: ["bodyEncoding"] },
);

const paginationSchema = s.looseObject(
  {
    page: s.nonNegativeInteger("Current page number."),
    pageSize: s.nonNegativeInteger("Requested page size."),
    pageCount: s.nonNegativeInteger("Number of pages returned."),
    itemCount: s.nonNegativeInteger("Number of items returned."),
  },
  { description: "Pagination details returned by Xero." },
);

const organisationSchema = s.looseObject(
  {
    OrganisationID: s.uuid("Unique Xero organisation ID."),
    Name: s.nonEmptyString("Organisation display name."),
    LegalName: s.nonEmptyString("Legal organisation name."),
    Version: s.nonEmptyString("Country-specific Xero organisation version."),
    OrganisationType: s.nonEmptyString("Organisation type."),
    BaseCurrency: s.nonEmptyString("Base currency code."),
    CountryCode: s.nonEmptyString("Organisation country code."),
    OrganisationStatus: s.nonEmptyString("Organisation status."),
    IsDemoCompany: s.boolean("Whether this is the Xero demo company."),
    Timezone: s.nonEmptyString("Organisation timezone."),
  },
  { description: "Xero organisation." },
);

const contactSchema = s.looseObject(
  {
    ContactID: s.uuid("Unique Xero contact ID."),
    ContactNumber: s.nullableString("User-defined contact number."),
    ContactStatus: s.stringEnum("Contact status.", ["ACTIVE", "ARCHIVED", "GDPRREQUEST"]),
    Name: s.nonEmptyString("Contact or business name."),
    FirstName: s.nullableString("Contact first name."),
    LastName: s.nullableString("Contact last name."),
    EmailAddress: s.nullableString("Contact email address."),
    IsSupplier: s.boolean("Whether the contact is a supplier."),
    IsCustomer: s.boolean("Whether the contact is a customer."),
    UpdatedDateUTC: s.string("Xero contact update timestamp."),
  },
  { description: "Xero contact." },
);

const accountSchema = s.looseObject(
  {
    AccountID: s.uuid("Unique Xero account ID."),
    Code: s.nonEmptyString("Account code."),
    Name: s.nonEmptyString("Account name."),
    Type: s.nonEmptyString("Account type."),
    Status: s.stringEnum("Account status.", ["ACTIVE", "ARCHIVED"]),
    TaxType: s.nullableString("Default tax type for the account."),
    Description: s.nullableString("Account description."),
    CurrencyCode: s.nullableString("Currency code for a bank account."),
  },
  { description: "Xero chart-of-accounts entry." },
);

const bankTransactionSchema = s.looseObject(
  {
    BankTransactionID: s.uuid("Unique Xero bank transaction ID."),
    Type: s.stringEnum("Bank transaction direction.", [
      "SPEND",
      "RECEIVE",
      "SPEND-TRANSFER",
      "RECEIVE-TRANSFER",
      "SPEND-PREPAYMENT",
      "RECEIVE-PREPAYMENT",
      "SPEND-OVERPAYMENT",
      "RECEIVE-OVERPAYMENT",
    ]),
    Status: s.stringEnum("Bank transaction status.", ["AUTHORISED", "DELETED"]),
    IsReconciled: s.boolean("Whether Xero marks the bank transaction as reconciled."),
    DateString: s.nullableString("Bank transaction date."),
    Reference: s.nullableString("Bank transaction reference."),
    CurrencyCode: s.nullableString("Bank transaction currency code."),
    CurrencyRate: s.number("Exchange rate to the organisation's base currency."),
    SubTotal: s.number("Transaction subtotal before tax."),
    TotalTax: s.number("Transaction tax total."),
    Total: s.number("Transaction total including tax."),
    BankAccount: accountSchema,
    Contact: s.looseObject(
      {
        ContactID: s.uuid("Xero contact ID."),
        Name: s.nonEmptyString("Contact name."),
      },
      { description: "Contact associated with the bank transaction." },
    ),
    UpdatedDateUTC: s.string("Xero update timestamp."),
    HasAttachments: s.boolean("Whether the transaction has attachments."),
  },
  { description: "Xero spend-money, receive-money, transfer, prepayment, or overpayment transaction." },
);

const paymentSchema = s.looseObject(
  {
    PaymentID: s.uuid("Unique Xero payment ID."),
    Date: s.nullableString("Payment date."),
    Amount: s.number("Payment amount in the source document currency."),
    BankAmount: s.number("Payment amount in the bank account currency."),
    CurrencyRate: s.number("Exchange rate used for the payment."),
    Reference: s.nullableString("Payment reference."),
    IsReconciled: s.boolean("Whether Xero marks the payment as reconciled."),
    Status: s.nonEmptyString("Payment status."),
    PaymentType: s.nonEmptyString("Xero payment type."),
    UpdatedDateUTC: s.string("Xero update timestamp."),
    BatchPaymentID: s.nullableString("Batch payment ID when this payment belongs to a batch."),
    Account: accountSchema,
    Invoice: s.looseObject(
      {
        InvoiceID: s.uuid("Related invoice ID."),
        InvoiceNumber: s.nullableString("Related invoice number."),
      },
      { description: "Invoice paid by this payment, when applicable." },
    ),
  },
  { description: "Xero payment with its available reconciliation status." },
);

const batchPaymentSchema = s.looseObject(
  {
    BatchPaymentID: s.uuid("Unique Xero batch payment ID."),
    Type: s.stringEnum("Batch payment direction.", ["PAYBATCH", "RECBATCH"]),
    Status: s.stringEnum("Batch payment status.", ["AUTHORISED", "DELETED"]),
    Date: s.nullableString("Batch payment date."),
    TotalAmount: s.number("Total amount of the batch payment."),
    IsReconciled: s.boolean("Whether Xero marks the batch payment as reconciled."),
    UpdatedDateUTC: s.string("Xero update timestamp."),
    Account: accountSchema,
    Payments: s.array("Payments included in this batch.", paymentSchema),
  },
  { description: "Xero batch payment with its reconciliation status." },
);

const bankTransferSchema = s.looseObject(
  {
    BankTransferID: s.uuid("Unique Xero bank transfer ID."),
    DateString: s.nullableString("Transfer date."),
    Amount: s.number("Transfer amount in the source account currency."),
    CurrencyRate: s.number("Exchange rate between source and destination accounts."),
    Reference: s.nullableString("Transfer reference."),
    Status: s.stringEnum("Bank transfer status.", ["AUTHORISED", "DELETED"]),
    FromBankAccount: accountSchema,
    ToBankAccount: accountSchema,
    FromBankTransactionID: s.uuid("Source-side bank transaction ID."),
    ToBankTransactionID: s.uuid("Destination-side bank transaction ID."),
    FromIsReconciled: s.boolean("Whether Xero marks the source side as reconciled."),
    ToIsReconciled: s.boolean("Whether Xero marks the destination side as reconciled."),
    CreatedDateUTCString: s.string("Xero creation timestamp."),
  },
  { description: "Xero transfer between two bank accounts with reconciliation flags for both sides." },
);

const reportSchema = s.looseObject(
  {
    ReportID: s.nonEmptyString("Xero report identifier."),
    ReportName: s.nonEmptyString("Report name."),
    ReportType: s.nonEmptyString("Report type."),
    ReportDate: s.nullableString("Report date."),
    UpdatedDateUTC: s.string("Report generation timestamp."),
    ReportTitles: s.stringArray("Report title lines."),
    Rows: s.array("Structured Xero report rows and cells.", s.unknown("One report row.")),
  },
  { description: "Xero report response." },
);

const cashValidationStatementLinesSchema = s.looseObject(
  {
    unreconciledAmountPos: s.number("Total positive value of unreconciled statement lines."),
    unreconciledAmountNeg: s.number("Total negative value of unreconciled statement lines."),
    unreconciledLines: s.nonNegativeInteger("Number of unreconciled statement lines."),
    avgDaysUnreconciledPos: s.number("Average age in days of positive unreconciled lines."),
    avgDaysUnreconciledNeg: s.number("Average age in days of negative unreconciled lines."),
    earliestUnreconciledTransaction: s.nullableString("Date of the earliest unreconciled statement line."),
    latestUnreconciledTransaction: s.nullableString("Date of the latest unreconciled statement line."),
    reconciledAmountPos: s.number("Total positive value of reconciled statement lines."),
    reconciledAmountNeg: s.number("Total negative value of reconciled statement lines."),
    reconciledLines: s.nonNegativeInteger("Number of reconciled statement lines."),
    earliestReconciledTransaction: s.nullableString("Date of the earliest reconciled statement line."),
    latestReconciledTransaction: s.nullableString("Date of the latest reconciled statement line."),
    deletedAmount: s.number("Total value of deleted statement lines."),
    totalAmount: s.number("Total statement-line value."),
  },
  { description: "Aggregate Xero bank-statement reconciliation metrics." },
);

const cashValidationSchema = s.looseObject(
  {
    accountId: s.uuid("Xero bank account ID."),
    statementBalance: s.looseObject(
      {
        value: s.number("Latest statement balance."),
        type: s.stringEnum("Statement balance direction.", ["DEBIT", "CREDIT"]),
      },
      { description: "Latest imported statement balance." },
    ),
    statementBalanceDate: s.nullableString("Date of the latest statement balance."),
    bankStatement: s.looseObject(
      {
        statementLines: cashValidationStatementLinesSchema,
        currentStatement: s.looseObject(
          {
            startDate: s.nullableString("Current statement start date."),
            endDate: s.nullableString("Current statement end date."),
            startBalance: s.number("Current statement opening balance."),
            endBalance: s.number("Current statement closing balance."),
            importedDateTimeUtc: s.nullableString("Current statement import timestamp."),
            importSourceType: s.nullableString("Current statement import source."),
          },
          { description: "Most recent statement available as at the requested system date." },
        ),
      },
      { description: "Bank-statement reconciliation aggregates and current statement." },
    ),
    cashAccount: s.looseObject(
      {
        unreconciledAmountPos: s.number("Positive accounting value not reconciled to statement lines."),
        unreconciledAmountNeg: s.number("Negative accounting value not reconciled to statement lines."),
        startingBalance: s.number("Starting accounting balance."),
        accountBalance: s.number("Current accounting balance."),
        balanceCurrency: s.nullableString("Account balance currency."),
      },
      { description: "Xero cash-account values compared with statement data." },
    ),
  },
  { description: "Cash and reconciliation summary for one Xero bank account." },
);

const bankStatementLineSchema = s.looseObject(
  {
    statementLineId: s.uuid("Xero bank statement line ID."),
    postedDate: s.nullableString("Date the bank posted the statement line."),
    transactionDate: s.nullableString("Transaction date."),
    payee: s.nullableString("Statement-line payee."),
    reference: s.nullableString("Statement-line reference."),
    notes: s.nullableString("Statement-line notes."),
    chequeNo: s.nullableString("Cheque number."),
    amount: s.number("Signed statement-line amount."),
    type: s.nullableString("Statement-line transaction type."),
    isReconciled: s.boolean("Whether this statement line has been reconciled."),
    isDuplicate: s.boolean("Whether Xero marks this statement line as a duplicate."),
    isDeleted: s.boolean("Whether this statement line has been deleted."),
    payments: s.array("Payments matched to this reconciled line.", s.unknown("Linked payment.")),
    bankTransactions: s.array(
      "Bank transactions matched to this reconciled line.",
      s.unknown("Linked bank transaction."),
    ),
  },
  { description: "Xero bank statement line and any linked reconciliation data." },
);

const bankStatementReconciliationSchema = s.looseObject(
  {
    bankAccountId: s.uuid("Xero bank account ID."),
    bankAccountName: s.nonEmptyString("Bank account name."),
    bankAccountCurrencyCode: s.nonEmptyString("Bank account currency code."),
    statements: s.array(
      "Bank statements returned for the period.",
      s.looseObject(
        {
          statementId: s.uuid("Xero bank statement ID."),
          startDate: s.nullableString("Statement start date."),
          endDate: s.nullableString("Statement end date."),
          importedDateTimeUtc: s.nullableString("Statement import timestamp."),
          importSource: s.nullableString("Statement import source."),
          startBalance: s.number("Statement opening balance."),
          endBalance: s.number("Statement closing balance."),
          indicativeStartBalance: s.number("Indicative opening balance."),
          indicativeEndBalance: s.number("Indicative closing balance."),
          statementLines: s.array("Statement lines and their reconciliation data.", bankStatementLineSchema),
        },
        { description: "Imported Xero bank statement." },
      ),
    ),
  },
  { description: "Bank statement lines with linked accounting data where Xero has reconciled them." },
);

const taxRateSchema = s.looseObject(
  {
    Name: s.nonEmptyString("Tax rate display name."),
    TaxType: s.nonEmptyString("Tax type code used on transactions."),
    Status: s.stringEnum("Tax rate status.", ["ACTIVE", "DELETED", "ARCHIVED", "PENDING"]),
    DisplayTaxRate: s.number("Displayed tax rate percentage."),
    EffectiveRate: s.number("Effective tax rate percentage."),
  },
  { description: "Xero tax rate." },
);

const trackingOptionSchema = s.looseObject(
  {
    TrackingOptionID: s.uuid("Unique tracking option ID."),
    Name: s.nonEmptyString("Tracking option name."),
    Status: s.nonEmptyString("Tracking option status."),
  },
  { description: "Xero tracking option." },
);

const trackingCategorySchema = s.looseObject(
  {
    TrackingCategoryID: s.uuid("Unique tracking category ID."),
    Name: s.nonEmptyString("Tracking category name."),
    Status: s.nonEmptyString("Tracking category status."),
    Options: s.array("Options in the tracking category.", trackingOptionSchema),
  },
  { description: "Xero tracking category." },
);

const itemSchema = s.looseObject(
  {
    ItemID: s.uuid("Unique Xero item ID."),
    Code: s.nonEmptyString("Item code."),
    Name: s.nullableString("Item name."),
    Description: s.nullableString("Sales description."),
    PurchaseDescription: s.nullableString("Purchase description."),
    IsSold: s.boolean("Whether the item can be sold."),
    IsPurchased: s.boolean("Whether the item can be purchased."),
    IsTrackedAsInventory: s.boolean("Whether Xero tracks inventory for the item."),
  },
  { description: "Xero product or service item." },
);

const invoiceContactSchema = s.looseObject(
  {
    ContactID: s.uuid("Unique Xero contact ID."),
    Name: s.nonEmptyString("Contact name."),
    EmailAddress: s.nullableString("Contact email address."),
  },
  { description: "Contact associated with an invoice." },
);

const invoiceLineSchema = s.looseObject(
  {
    LineItemID: s.uuid("Unique line item ID."),
    Description: s.nullableString("Line item description."),
    Quantity: s.number("Line item quantity."),
    UnitAmount: s.number("Amount per unit."),
    AccountCode: s.nullableString("Account code assigned to the line."),
    TaxType: s.nullableString("Tax type applied to the line."),
    TaxAmount: s.number("Tax amount for the line."),
    LineAmount: s.number("Line total before or including tax according to LineAmountTypes."),
  },
  { description: "Xero invoice line item." },
);

const invoiceSchema = s.looseObject(
  {
    InvoiceID: s.uuid("Unique Xero invoice ID."),
    InvoiceNumber: s.nullableString("Sales invoice or bill number."),
    Type: s.stringEnum("Invoice direction.", ["ACCREC", "ACCPAY"]),
    Status: s.stringEnum("Invoice status.", ["DRAFT", "SUBMITTED", "DELETED", "AUTHORISED", "PAID", "VOIDED"]),
    Contact: invoiceContactSchema,
    DateString: s.nullableString("Invoice date."),
    DueDateString: s.nullableString("Invoice due date."),
    Reference: s.nullableString("Invoice reference."),
    CurrencyCode: s.nullableString("Invoice currency code."),
    SubTotal: s.number("Invoice subtotal."),
    TotalTax: s.number("Total invoice tax."),
    Total: s.number("Invoice total."),
    AmountDue: s.number("Outstanding amount."),
    AmountPaid: s.number("Amount paid."),
    UpdatedDateUTC: s.string("Xero invoice update timestamp."),
    LineItems: s.array("Invoice line items when returned by Xero.", invoiceLineSchema),
  },
  { description: "Xero sales invoice or purchase bill." },
);

const listInputFields = {
  page: pageSchema,
  pageSize: pageSizeSchema,
  orderBy: s.nonEmptyString("Xero order expression, such as UpdatedDateUTC DESC."),
  searchTerm: s.nonEmptyString("Case-insensitive search term supported by the resource."),
  summaryOnly: s.boolean("Return Xero's lightweight summary representation."),
};

const listInputOptional = ["page", "pageSize", "orderBy", "searchTerm", "summaryOnly"];
const reconciliationFilterFields = {
  where: s.nonEmptyString("Additional Xero filter expression."),
  orderBy: s.nonEmptyString("Xero order expression, such as UpdatedDateUTC DESC."),
  ifModifiedSince: s.dateTime("Only return records created or modified after this timestamp."),
};

export const xeroActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_organisation",
    description: "Get details of the organisation authorised for this Xero Custom Connection.",
    inputSchema: noInputSchema,
    outputSchema: s.actionOutput({ organisation: organisationSchema }, "Connected Xero organisation."),
    requiredScopes: [xeroScopes.settingsRead],
  }),
  defineProviderAction(service, {
    name: "retrieve_endpoint",
    description:
      "Send a read-only GET request to any endpoint in a supported Xero API family. Use the endpoint path and query parameters from Xero's API documentation; Xero enforces the endpoint-specific scopes configured on the Custom Connection.",
    inputSchema: s.object(
      "A read-only Xero API request. Partner-only families still require Xero approval, and payroll endpoints require the matching regional organisation and payroll scopes.",
      {
        api: s.stringEnum(xeroApiFamilyDescription, xeroApiFamilyNames),
        endpoint: s.string(
          "Relative endpoint path beginning with one slash, such as /BankTransactions, /Reports/ProfitAndLoss, /Assets, or /Files/{fileId}/Content.",
          { minLength: 2, maxLength: 2048, pattern: "^/[^/]" },
        ),
        query: s.record(
          s.anyOf("One query parameter value.", [
            s.string("String query value."),
            s.number("Numeric query value."),
            s.boolean("Boolean query value."),
          ]),
          {
            description:
              "Endpoint-specific query parameters. Encode multi-value Xero filters as comma-separated strings.",
          },
        ),
        accept: s.stringEnum("Requested response type.", [
          "application/json",
          "application/xml",
          "application/pdf",
          "application/octet-stream",
          "*/*",
        ]),
        ifModifiedSince: s.dateTime("Only retrieve Accounting API records modified after this timestamp."),
        tenantId: s.uuid(
          "Optional Xero tenant ID for partner endpoints that explicitly require the xero-tenant-id header.",
        ),
      },
      { required: ["api", "endpoint"], optional: ["query", "accept", "ifModifiedSince", "tenantId"] },
    ),
    outputSchema: retrievalResponseSchema,
    requiredScopes: [],
  }),
  defineProviderAction(service, {
    name: "list_contacts",
    description: "List or search contacts in the connected Xero organisation.",
    inputSchema: s.object(
      "Contact filters and pagination.",
      {
        ...listInputFields,
        includeArchived: s.boolean("Include archived contacts."),
      },
      { optional: [...listInputOptional, "includeArchived"] },
    ),
    outputSchema: listOutputSchema("contacts", "Contacts returned by Xero.", contactSchema),
    requiredScopes: [xeroScopes.contactsWrite],
    followUpActions: ["xero.get_contact", "xero.create_contact"],
  }),
  defineProviderAction(service, {
    name: "get_contact",
    description: "Get one Xero contact by its unique contact ID.",
    inputSchema: s.actionInput({ contactId: s.uuid("Unique Xero contact ID.") }, ["contactId"]),
    outputSchema: s.actionOutput({ contact: contactSchema }, "Selected Xero contact."),
    requiredScopes: [xeroScopes.contactsWrite],
  }),
  defineProviderAction(service, {
    name: "create_contact",
    description: "Create a contact in the connected Xero organisation.",
    inputSchema: s.actionInput(
      {
        name: s.nonEmptyString("Unique contact or business name."),
        firstName: s.nonEmptyString("Contact first name."),
        lastName: s.nonEmptyString("Contact last name."),
        emailAddress: s.email("Contact email address."),
        contactNumber: s.nonEmptyString("User-defined contact number."),
        accountNumber: s.nonEmptyString("User-defined account number."),
        idempotencyKey: s.string("Optional retry-safe Xero idempotency key.", { maxLength: 128 }),
      },
      ["name"],
      "Contact details to create.",
    ),
    outputSchema: s.actionOutput({ contact: contactSchema }, "Created Xero contact."),
    requiredScopes: [xeroScopes.contactsWrite],
  }),
  defineProviderAction(service, {
    name: "list_accounts",
    description: "List the Xero chart of accounts.",
    inputSchema: s.object(
      "Optional Xero account filters.",
      {
        where: s.nonEmptyString('Xero filter expression, such as Status=="ACTIVE".'),
        orderBy: s.nonEmptyString("Xero order expression, such as Name ASC."),
      },
      { optional: ["where", "orderBy"] },
    ),
    outputSchema: listOutputSchema("accounts", "Accounts returned by Xero.", accountSchema),
    requiredScopes: [xeroScopes.settingsRead],
  }),
  defineProviderAction(service, {
    name: "list_bank_transactions",
    description:
      "List Xero spend-money, receive-money, transfer, prepayment, and overpayment transactions with their available IsReconciled flags. This does not expose unreconciled bank statement lines.",
    inputSchema: s.object(
      "Bank transaction reconciliation filters.",
      {
        ...reconciliationFilterFields,
        page: pageSchema,
        reconciled: s.boolean("Only return transactions with this reconciliation state."),
        includeDeleted: s.boolean("Include deleted bank transactions."),
        unitDecimalPlaces: s.anyOf("Line-item decimal precision returned by Xero.", [
          s.literal(2, { description: "Return two decimal places." }),
          s.literal(4, { description: "Return four decimal places." }),
        ]),
      },
      {
        optional: ["where", "orderBy", "ifModifiedSince", "page", "reconciled", "includeDeleted", "unitDecimalPlaces"],
      },
    ),
    outputSchema: listOutputSchema("bankTransactions", "Bank transactions returned by Xero.", bankTransactionSchema),
    requiredScopes: [xeroScopes.bankTransactionsRead],
  }),
  defineProviderAction(service, {
    name: "list_payments",
    description:
      "List Xero invoice, credit-note, prepayment, and overpayment payments with their available IsReconciled flags.",
    inputSchema: s.object(
      "Payment reconciliation filters and pagination.",
      {
        ...reconciliationFilterFields,
        page: pageSchema,
        pageSize: pageSizeSchema,
        reconciled: s.boolean("Only return payments with this reconciliation state."),
      },
      { optional: ["where", "orderBy", "ifModifiedSince", "page", "pageSize", "reconciled"] },
    ),
    outputSchema: listOutputSchema("payments", "Payments returned by Xero.", paymentSchema),
    requiredScopes: [xeroScopes.paymentsRead],
  }),
  defineProviderAction(service, {
    name: "list_batch_payments",
    description: "List Xero batch payments with their available IsReconciled flags.",
    inputSchema: s.object(
      "Batch payment reconciliation filters.",
      {
        ...reconciliationFilterFields,
        reconciled: s.boolean("Only return batch payments with this reconciliation state."),
      },
      { optional: ["where", "orderBy", "ifModifiedSince", "reconciled"] },
    ),
    outputSchema: listOutputSchema("batchPayments", "Batch payments returned by Xero.", batchPaymentSchema),
    requiredScopes: [xeroScopes.paymentsRead],
  }),
  defineProviderAction(service, {
    name: "list_bank_transfers",
    description: "List Xero bank transfers with reconciliation flags for both the source and destination accounts.",
    inputSchema: s.object(
      "Bank transfer reconciliation filters.",
      {
        ...reconciliationFilterFields,
        includeDeleted: s.boolean("Include deleted bank transfers."),
        sourceReconciled: s.boolean("Only return transfers whose source side has this reconciliation state."),
        destinationReconciled: s.boolean("Only return transfers whose destination side has this reconciliation state."),
      },
      {
        optional: [
          "where",
          "orderBy",
          "ifModifiedSince",
          "includeDeleted",
          "sourceReconciled",
          "destinationReconciled",
        ],
      },
    ),
    outputSchema: listOutputSchema("bankTransfers", "Bank transfers returned by Xero.", bankTransferSchema),
    requiredScopes: [xeroScopes.bankTransactionsRead],
  }),
  defineProviderAction(service, {
    name: "get_bank_summary",
    description:
      "Get Xero's Bank Summary report showing balances and cash movements for each bank account. This is a financial summary, not bank statement reconciliation lines.",
    inputSchema: s.object(
      "Optional Bank Summary reporting period.",
      {
        fromDate: s.date("Inclusive report start date."),
        toDate: s.date("Inclusive report end date."),
      },
      { optional: ["fromDate", "toDate"] },
    ),
    outputSchema: s.actionOutput({ report: reportSchema }, "Xero Bank Summary report."),
    requiredScopes: [xeroScopes.bankSummaryRead],
  }),
  defineProviderAction(service, {
    name: "get_cash_validation",
    description:
      "Get per-account reconciliation totals, unreconciled line counts and amounts, statement balances, and accounting balances from Xero's partner-only Finance API.",
    inputSchema: s.object(
      "Optional dates for the Xero cash-validation snapshot.",
      {
        balanceDate: s.date("Latest accounting date included in the aggregate values."),
        asAtSystemDate: s.date("Historical Xero system date used to estimate reconciliation state."),
        beginDate: s.date("Earliest accounting date included in the aggregate values."),
      },
      { optional: ["balanceDate", "asAtSystemDate", "beginDate"] },
    ),
    outputSchema: s.actionOutput(
      { accounts: s.array("Cash-validation results for the organisation's bank accounts.", cashValidationSchema) },
      "Xero cash-validation and reconciliation summary.",
    ),
    requiredScopes: [xeroScopes.cashValidationRead],
  }),
  defineProviderAction(service, {
    name: "get_bank_statement_reconciliation",
    description:
      "Get bank statement lines and the payments, invoices, credit notes, prepayments, overpayments, or bank transactions linked by reconciliation. Requires Xero Finance API partner access.",
    inputSchema: s.actionInput(
      {
        bankAccountId: s.uuid("Xero bank account ID."),
        fromDate: s.date("Inclusive statement start date; the range cannot exceed 12 months."),
        toDate: s.date("Inclusive statement end date, which cannot be in the future."),
        summaryOnly: s.boolean(
          "Exclude detailed line items from linked accounting records; Xero defaults this to true.",
        ),
      },
      ["bankAccountId", "fromDate", "toDate"],
      "Bank account and reporting period to inspect.",
    ),
    outputSchema: s.actionOutput(
      { reconciliation: bankStatementReconciliationSchema },
      "Xero bank statements and linked reconciliation data.",
    ),
    requiredScopes: [xeroScopes.bankStatementsPlusRead],
  }),
  defineProviderAction(service, {
    name: "list_tax_rates",
    description: "List tax rates configured in the connected Xero organisation.",
    inputSchema: noInputSchema,
    outputSchema: listOutputSchema("taxRates", "Tax rates returned by Xero.", taxRateSchema),
    requiredScopes: [xeroScopes.settingsRead],
  }),
  defineProviderAction(service, {
    name: "list_tracking_categories",
    description: "List tracking categories and options configured in Xero.",
    inputSchema: noInputSchema,
    outputSchema: listOutputSchema(
      "trackingCategories",
      "Tracking categories returned by Xero.",
      trackingCategorySchema,
    ),
    requiredScopes: [xeroScopes.settingsRead],
  }),
  defineProviderAction(service, {
    name: "list_items",
    description: "List products and services configured as Xero items.",
    inputSchema: s.object(
      "Optional Xero item filters and ordering.",
      {
        where: s.nonEmptyString("Xero filter expression, such as IsSold==true."),
        orderBy: listInputFields.orderBy,
      },
      { optional: ["where", "orderBy"] },
    ),
    outputSchema: listOutputSchema("items", "Items returned by Xero.", itemSchema),
    requiredScopes: [xeroScopes.settingsRead],
  }),
  defineProviderAction(service, {
    name: "list_invoices",
    description:
      "List or search sales invoices and purchase bills in Xero. Do not combine summaryOnly=true with ordering by DueDate because Xero rejects that parameter combination.",
    inputSchema: s.object(
      "Invoice filters and pagination.",
      {
        ...listInputFields,
        statuses: s.array(
          "Only return invoices with these statuses.",
          s.stringEnum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"]),
        ),
        contactIds: s.array("Only return invoices for these Xero contact IDs.", s.uuid("Xero contact ID.")),
        invoiceNumbers: s.stringArray("Only return these invoice numbers."),
      },
      { optional: [...listInputOptional, "statuses", "contactIds", "invoiceNumbers"] },
    ),
    outputSchema: listOutputSchema("invoices", "Invoices returned by Xero.", invoiceSchema),
    requiredScopes: [xeroScopes.invoicesWrite],
    followUpActions: ["xero.get_invoice", "xero.create_draft_invoice"],
  }),
  defineProviderAction(service, {
    name: "get_invoice",
    description: "Get one Xero sales invoice or purchase bill with its line items.",
    inputSchema: s.actionInput({ invoiceId: s.uuid("Unique Xero invoice ID.") }, ["invoiceId"]),
    outputSchema: s.actionOutput({ invoice: invoiceSchema }, "Selected Xero invoice."),
    requiredScopes: [xeroScopes.invoicesWrite],
  }),
  defineProviderAction(service, {
    name: "create_draft_invoice",
    description: "Create one draft sales invoice or purchase bill in Xero.",
    inputSchema: s.actionInput(
      {
        type: s.stringEnum("Create a sales invoice (ACCREC) or purchase bill (ACCPAY).", ["ACCREC", "ACCPAY"]),
        contactId: s.uuid("Existing Xero contact ID."),
        date: s.date("Invoice date."),
        dueDate: s.date("Invoice due date."),
        reference: s.nonEmptyString("Invoice reference."),
        currencyCode: s.nonEmptyString("Three-letter invoice currency code."),
        lineAmountTypes: s.stringEnum("How line amounts treat tax.", ["Exclusive", "Inclusive", "NoTax"]),
        idempotencyKey: s.string("Optional retry-safe Xero idempotency key.", { maxLength: 128 }),
        lineItems: s.array(
          "Invoice line items.",
          s.object(
            "One invoice line item.",
            {
              description: s.nonEmptyString("Line item description."),
              quantity: s.number("Quantity."),
              unitAmount: s.number("Amount per unit."),
              accountCode: s.nonEmptyString("Xero account code."),
              taxType: s.nonEmptyString("Optional Xero tax type code."),
            },
            { required: ["description", "quantity", "unitAmount", "accountCode"], optional: ["taxType"] },
          ),
          { minItems: 1 },
        ),
      },
      ["type", "contactId", "lineItems"],
      "Draft invoice details. Xero determines the invoice number when omitted.",
    ),
    outputSchema: s.actionOutput({ invoice: invoiceSchema }, "Created draft Xero invoice."),
    requiredScopes: [xeroScopes.invoicesWrite],
    followUpActions: ["xero.get_invoice"],
  }),
];

function listOutputSchema(key: string, description: string, itemSchema: JsonSchema): JsonSchema {
  return s.object(
    `Paginated Xero ${key} response.`,
    { [key]: s.array(description, itemSchema), pagination: s.nullable(paginationSchema) },
    { required: [key, "pagination"] },
  );
}
