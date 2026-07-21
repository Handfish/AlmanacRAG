import { describe, expect, it } from "@effect/vitest";
import { detailHtml } from "@test/fixtures";
import { extractFields } from "./fields.js";

describe("fields", () => {
  it("captures the label/value table into a queryable object", () => {
    const f = extractFields(detailHtml({ courseId: "MATH101", sectionId: "MathSeries-94" }));
    expect(f.fields.status).toBe("Registration Available");
    expect(f.fields.courseId).toBe("MATH101");
    expect(f.fields.sectionId).toBe("MathSeries-94");
    expect(f.fields.session).toBe("Fall- 2026");
    expect(f.fields.dates).toContain("October 29, 2026");
    expect(f.fields.instructor).toBe("Teehan, Kare");
    expect(f.fields.location).toContain("On-line");
    expect(f.fields.prerequisites).toBe("None");
    expect(f.fields.audience).toBe("Elementary Teachers");
    expect(f.title).toContain("Elementary Math");
  });

  it("captures the fee breakdown as line items (Registration Fee + Total Fees)", () => {
    const f = extractFields(detailHtml({ fee: "149" }));
    expect(f.fees).toHaveLength(2);
    expect(f.fees[0]).toEqual({ amount: "$ 149", label: "Registration Fee" });
    expect(f.fees[1]?.label).toBe("Total Fees");
  });

  it("does not lose the section id when Course ID is blank (real-page shape)", () => {
    const f = extractFields(detailHtml());
    // blank Course ID collapses the pair; the value is still captured, not dropped
    const captured = f.fields.sectionId ?? f.fields.courseIdSectionId;
    expect(captured).toBe("MathSeries-94");
  });
});
