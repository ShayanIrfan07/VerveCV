import { describe, expect, it } from "vitest";
import { sourceLeakage } from "./check-scoring-boundary.mjs";

describe("frontend scoring boundary", () => {
  it("keeps rubric identifiers out of the web source", () => {
    expect(sourceLeakage()).toEqual([]);
  });
});
