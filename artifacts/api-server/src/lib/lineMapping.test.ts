import { describe, expect, it } from "vitest";
import { linesToLineItems, type EmployeeRow } from "./lineMapping";
import type { ParsedLine } from "./timeimport";

function makeEmployee(overrides: Partial<EmployeeRow> & { id: number; name: string }): EmployeeRow {
  return {
    classification: "Engineer",
    homeRate: 100,
    fieldRate: null,
    defaultTaskNo: null,
    ...overrides,
  } as EmployeeRow;
}

function makeLine(overrides: Partial<ParsedLine> & { employeeName: string }): ParsedLine {
  return {
    classification: "",
    category: "regular",
    location: "home",
    hours: 8,
    rate: 0,
    ...overrides,
  };
}

describe("linesToLineItems", () => {
  it("links a uniquely-named employee and applies their rate/classification", () => {
    const employees = [makeEmployee({ id: 1, name: "Alice Smith", homeRate: 120 })];
    const { toInsert, warnings } = linesToLineItems(
      [makeLine({ employeeName: "alice smith " })],
      42,
      employees,
      "import",
    );
    expect(toInsert).toHaveLength(1);
    expect(toInsert[0].employeeId).toBe(1);
    expect(toInsert[0].rate).toBe(120);
    expect(toInsert[0].classification).toBe("Engineer");
    expect(warnings).toHaveLength(0);
  });

  it("leaves employeeId null and warns when two employees share a name", () => {
    const employees = [
      makeEmployee({ id: 1, name: "John Doe", homeRate: 100, classification: "Engineer" }),
      makeEmployee({ id: 2, name: "john doe", homeRate: 250, classification: "Principal" }),
      makeEmployee({ id: 3, name: "Unique Person", homeRate: 90 }),
    ];
    const lines = [
      makeLine({ employeeName: "John Doe" }),
      makeLine({ employeeName: "John Doe", hours: 4 }),
      makeLine({ employeeName: "Unique Person" }),
    ];
    const { toInsert, warnings } = linesToLineItems(lines, 42, employees, "import");

    // Ambiguous rows are never linked to either same-name employee.
    expect(toInsert[0].employeeId).toBeNull();
    expect(toInsert[1].employeeId).toBeNull();
    // No rate can be safely inferred, so rate falls back to 0.
    expect(toInsert[0].rate).toBe(0);
    // Unique names still resolve normally.
    expect(toInsert[2].employeeId).toBe(3);
    expect(toInsert[2].rate).toBe(90);

    const ambiguousWarnings = warnings.filter((w) => w.includes("multiple employees share this name"));
    expect(ambiguousWarnings).toHaveLength(1);
    expect(ambiguousWarnings[0]).toContain("John Doe");
    expect(ambiguousWarnings[0]).toContain("manually");
  });

  it("handles three or more employees sharing a name", () => {
    const employees = [
      makeEmployee({ id: 1, name: "Jane Roe" }),
      makeEmployee({ id: 2, name: "Jane Roe" }),
      makeEmployee({ id: 3, name: " JANE ROE " }),
    ];
    const { toInsert, warnings } = linesToLineItems(
      [makeLine({ employeeName: "Jane Roe" })],
      42,
      employees,
      "import",
    );
    expect(toInsert[0].employeeId).toBeNull();
    expect(warnings.some((w) => w.includes("multiple employees share this name"))).toBe(true);
  });
});
