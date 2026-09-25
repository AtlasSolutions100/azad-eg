import { describe, it, expect } from "vitest";
import { projectScopeFilter } from "./procas";

/**
 * Procas does not post against a top-level project code. Work plan 10007's
 * entire billing history (347 invoices, $1,230,254.44) and all 6,627 of its
 * historical hours sit on the leaf code `10007.00.00.00.CA`. A
 * `Project eq '10007'` filter matched none of it and returned a confident $0,
 * which is what printed "Previously Billed --" on an invoice numbered 25.
 */
describe("projectScopeFilter", () => {
  it("matches the project and everything booked beneath it", () => {
    expect(projectScopeFilter("10007")).toBe(
      "(Project eq '10007' or startswith(Project,'10007.'))",
    );
  });

  it("keeps the dot so a neighbouring project cannot be swept in", () => {
    // Without the trailing dot, `startswith(Project,'10007')` would also match
    // an unrelated `100070`, silently adding another contract's billing.
    const filter = projectScopeFilter("10007");
    expect(filter).toContain("'10007.'");
    expect(filter).not.toContain("startswith(Project,'10007')");
  });

  it("works for a project that is already a sub-code", () => {
    // The Parsons work plan maps to 10009.03, whose rows live deeper still.
    expect(projectScopeFilter("10009.03")).toBe(
      "(Project eq '10009.03' or startswith(Project,'10009.03.'))",
    );
  });

  it("trims and escapes what it is given", () => {
    expect(projectScopeFilter("  10007  ")).toBe(
      "(Project eq '10007' or startswith(Project,'10007.'))",
    );
    expect(projectScopeFilter("O'Hare")).toBe(
      "(Project eq 'O''Hare' or startswith(Project,'O''Hare.'))",
    );
  });
});
