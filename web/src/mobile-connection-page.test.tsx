import { describe, expect, it } from "vitest";
import { describeMobileBrowser } from "./mobile-connection-page";

describe("describeMobileBrowser", () => {
  it("summarizes common mobile browser user agents without exposing the full value", () => {
    expect(
      describeMobileBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1 Version/18.0 Mobile Safari/604.1",
      ),
    ).toBe("iPhone · Safari");
    expect(describeMobileBrowser("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile")).toBe(
      "Android · Chrome",
    );
    expect(describeMobileBrowser(undefined)).toBe("Mobile browser");
  });
});
