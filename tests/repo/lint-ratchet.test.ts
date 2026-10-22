import { describe, expect, it } from "vitest";

import { evaluate } from "../../scripts/check-lint-ratchet.mjs";

describe("lint ratchet", () => {
  it("fails a rule that fires more often than recorded", () => {
    expect(evaluate({ complexity: 3 }, { rules: { complexity: 2 } }).problems).toEqual(["WORSE complexity: 2 -> 3."]);
  });

  it("fails a rule with no recorded baseline at all", () => {
    expect(evaluate({ "no-unused-vars": 1 }, { rules: {} }).problems).toHaveLength(1);
  });

  it("reports a drop, including to zero, without failing", () => {
    const { problems, improvements } = evaluate({ complexity: 1 }, { rules: { complexity: 2, eqeqeq: 4 } });
    expect(problems).toEqual([]);
    expect(improvements).toEqual(["complexity: 2 -> 1", "eqeqeq: 4 -> 0"]);
  });
});
