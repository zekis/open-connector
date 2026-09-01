# Microsoft Graph Admin

The Microsoft Graph Admin connector gives an agent a separately authorized Microsoft 365 tenant
administration connection. It can list, search, create, update, and delete users; inspect tenant
license capacity and a user's license details; and add or remove user licenses.

## Setup

1. Register a Microsoft Entra application and add the OpenConnector OAuth callback URL.
2. In OpenConnector, configure the **Microsoft Graph Admin** OAuth client. Use the target tenant ID
   when the connection must be restricted to one organization.
3. Grant delegated admin consent for `User.Read`, `User.Read.All`, `User.ReadWrite.All`,
   `User.EnableDisableAccount.All`, `User-PasswordProfile.ReadWrite.All`,
   `LicenseAssignment.Read.All`, `LicenseAssignment.ReadWrite.All`, and `offline_access`.
4. Connect using a Microsoft 365 administrator account with the directory role required for the
   operation, such as User Administrator or License Administrator.
5. Grant agents only the Graph Admin Actions they need. Keep destructive user and license changes
   behind OpenConnector approvals.

The connector intentionally has its own OAuth connection instead of adding tenant-wide permissions
to Microsoft Teams. Microsoft Graph evaluates both the delegated OAuth permission and the signed-in
administrator's Microsoft Entra role, so consent alone does not grant every operation.

## Actions

- `list_users`, `get_user`, `create_user`, `update_user`, and `delete_user`
- `set_user_account_enabled` and `reset_user_password` with their dedicated delegated permissions
- `list_subscribed_skus` and `list_user_licenses`
- `assign_user_licenses` for atomic additions and removals

Set `usageLocation` on a user before assigning products that require a usage country. License input
uses the Microsoft Graph SKU and service-plan GUIDs returned by `list_subscribed_skus`.
