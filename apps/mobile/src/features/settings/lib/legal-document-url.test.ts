import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://hybrid.preferedev.xyz/legal",
    "https://hybrid.preferedev.xyz/legal/",
    "https://hybrid.preferedev.xyz/privacy-policy?source=app",
    "https://hybrid.preferedev.xyz/terms-of-service#updates",
    "https://hybrid.preferedev.xyz/security-policy",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://hybrid.preferedev.xyz/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
