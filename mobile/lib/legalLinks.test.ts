import { deleteAccountUrl, privacyPolicyUrl, PRODUCTION_WEB_ORIGIN, webOrigin } from "./legalLinks";

describe("legal links", () => {
  it("uses the configured https origin, without a trailing slash", () => {
    expect(privacyPolicyUrl("https://example.test/")).toBe("https://example.test/privacy");
    expect(deleteAccountUrl("https://example.test")).toBe("https://example.test/delete-account");
  });

  it("falls back to production when the variable is unset, blank or not https", () => {
    // A reviewer tapping "Privacy policy" must never get undefined/privacy or
    // a dev machine's http://192.168… address.
    expect(webOrigin("")).toBe(PRODUCTION_WEB_ORIGIN);
    expect(webOrigin("   ")).toBe(PRODUCTION_WEB_ORIGIN);
    expect(webOrigin("http://192.168.1.10:3000")).toBe(PRODUCTION_WEB_ORIGIN);
    expect(privacyPolicyUrl(undefined)).toMatch(/^https:\/\/.+\/privacy$/);
  });
});
