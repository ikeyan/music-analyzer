import { describe, expect, it } from "bun:test";
import { constantTimeEqual } from "./auth";

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("returns false for same length but different content", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("a".repeat(64), "b".repeat(64))).toBe(false);
  });

  it("handles multibyte utf-8 correctly", () => {
    expect(constantTimeEqual("プロジェクト", "プロジェクト")).toBe(true);
    expect(constantTimeEqual("プロジェクト", "プロジェクトA")).toBe(false);
  });
});
