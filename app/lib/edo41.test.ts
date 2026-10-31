import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  EDO,
  edo41Degree,
  edo41NoteName,
  edo41Octave,
  edo41StepToHz,
  hzToEdo41Step,
} from "./edo41";

describe("edo41", () => {
  it("C4 = step 164 = 261.6256Hz、A4 は 41edo 格子上にない", () => {
    expect(edo41StepToHz(4 * EDO)).toBeCloseTo(261.6256, 3);
    expect(hzToEdo41Step(261.6256)).toBeCloseTo(4 * EDO, 3);
    expect(Math.abs(hzToEdo41Step(440) - Math.round(hzToEdo41Step(440)))).toBeGreaterThan(0.1);
  });

  // 性質: hzToEdo41Step ∘ edo41StepToHz = id、隣接 step の比は 2^(1/41)
  it("step ↔ Hz が往復し 1 step = 2^(1/41) 倍", () => {
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 400 }), (step) => {
        expect(hzToEdo41Step(edo41StepToHz(step))).toBeCloseTo(step, 6);
        expect(edo41StepToHz(step + 1) / edo41StepToHz(step)).toBeCloseTo(2 ** (1 / EDO), 9);
      }),
      { numRuns: 20 },
    );
  });

  it("degree / octave / note name", () => {
    expect(edo41Degree(164)).toBe(0);
    expect(edo41Octave(164)).toBe(4);
    expect(edo41Degree(-1)).toBe(40);
    expect(edo41Octave(-1)).toBe(-1);
    expect(edo41NoteName(164)).toBe("C4");
    expect(edo41NoteName(164 + 13)).toBe("vE4");
    expect(edo41NoteName(164 + 24)).toBe("G4");
    expect(edo41NoteName(164 + 31)).toBe("A4");
    // vC は上の octave の C として数える
    expect(edo41NoteName(164 + 40)).toBe("vC5");
    expect(edo41NoteName(41)).toBe("C1");
  });
});
