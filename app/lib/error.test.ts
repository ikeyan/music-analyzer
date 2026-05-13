import { describe, expect, it } from "bun:test";
import { describeError } from "./error";

describe("describeError", () => {
  it("returns Error.message for Error instances", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("preserves messages shorter than 500 chars unchanged", () => {
    expect(describeError(new Error("short"))).toBe("short");
    expect(describeError("short")).toBe("short");
  });

  it("returns String(err) for non-Error throws", () => {
    expect(describeError("string thrown")).toBe("string thrown");
    expect(describeError(42)).toBe("42");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError({ foo: "bar" })).toBe("[object Object]");
  });

  it("truncates Error.message to 500 chars", () => {
    expect(describeError(new Error("x".repeat(2000)))).toBe("x".repeat(500));
  });

  it("truncates stringified non-Error values to 500 chars", () => {
    expect(describeError("y".repeat(1000)).length).toBe(500);
  });

  it("handles Error subclasses", () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "CustomError";
      }
    }
    expect(describeError(new CustomError("custom"))).toBe("custom");
  });
});
