import assert from "node:assert/strict";
import { test } from "node:test";
process.env.OCGW_GATEWAY_URL = "https://connector.example.com/";
const { isExternalUrl, isGatewayUrl } = await import("./navigation.mjs");

test("only the exact HTTPS gateway origin can stay in the app", () => {
  assert.equal(isGatewayUrl("https://connector.example.com/feed"), true);
  for (const url of [
    "https://connector.example.com.attacker.test",
    "http://connector.example.com",
    "https://connector.example.com:444",
    "https://user:secret@connector.example.com",
    "javascript:alert(1)",
    "file:///C:/Windows",
    "invalid",
  ]) {
    assert.equal(isGatewayUrl(url), false, url);
  }
});

test("external links cannot launch arbitrary local protocols", () => {
  for (const url of ["https://example.com", "http://example.com", "mailto:person@example.com"])
    assert.equal(isExternalUrl(url), true);
  for (const url of [
    "file:///C:/Windows",
    "powershell:run",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:secret@example.com",
    "invalid",
  ])
    assert.equal(isExternalUrl(url), false);
});
