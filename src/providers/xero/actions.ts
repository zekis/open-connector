import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { xeroScopes } from "./scopes.ts";

const service = "xero";

const noInputSchema = s.object("No input is required.", {});
const pageSchema = s.positiveInteger("Page number to return.");
const pageSizeSchema = s.positiveInteger("Number of records to return per page.");

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

export const xeroActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_organisation",
    description: "Get details of the organisation authorised for this Xero Custom Connection.",
    inputSchema: noInputSchema,
    outputSchema: s.actionOutput({ organisation: organisationSchema }, "Connected Xero organisation."),
    requiredScopes: [xeroScopes.settingsRead],
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
    description: "List or search sales invoices and purchase bills in Xero.",
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
