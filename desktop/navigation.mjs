const configuredUrl = new URL(process.env.OCGW_GATEWAY_URL || "https://connector.example.com/");
if (configuredUrl.protocol !== "https:" || configuredUrl.username || configuredUrl.password) {
  throw new Error("OCGW_GATEWAY_URL must be an HTTPS URL without embedded credentials.");
}
export const gatewayUrl = configuredUrl.href;

/** Only the exact gateway origin is allowed inside the privileged app shell. */
export function isGatewayUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === new URL(gatewayUrl).origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** External navigation is limited to ordinary web links and email composition. */
export function isExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
