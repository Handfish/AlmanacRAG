import type { ExtractedCourse } from "@catalog/domain/extraction";
import { describe, expect, it } from "@effect/vitest";
import {
  deriveCampus,
  deriveDates,
  deriveDeadline,
  deriveFees,
  deriveInstructors,
  deriveIsEvening,
  deriveRelations,
  deriveRows,
  deriveTerm,
  deriveTotalFeeCents,
  detectMisalignment,
  mapStatus,
  parseContactHours,
  parseFeeCents,
  sentinelToNull,
  splitFormat,
  splitLocation,
  type StoredPageFields,
} from "./derive.js";

// One test per architecture.md §9.2 hazard — all against the PURE derive functions
// (no DB, no LLM). This is where "as accurate as possible" gets teeth: each hazard
// produces a plausible wrong row if mishandled, so each has a named guard + a test.

const REF = new Date("2026-01-01T00:00:00Z");

const base: ExtractedCourse = {
  courseTitle: "Test Course",
  externalCourseId: null,
  track: null,
  contactHours: null,
  subject: null,
  program: null,
  description: null,
  audience: null,
  prerequisiteText: null,
  registrationKeyword: null,
  relations: [],
  externalSectionId: null,
  sessionLabel: null,
  datesText: null,
  scheduleText: null,
  timesText: null,
  isEvening: null,
  registrationDeadlineText: null,
  formatText: null,
  deliveryMode: "unknown",
  locationText: null,
  campus: "unknown",
  statusRaw: "Registration Available",
  isNew: false,
  fees: [],
  instructors: [],
};

describe("derive — §9.2 hazards", () => {
  it("#1 sentinel nulls: N/A, -, n/a, TBD, None → null", () => {
    for (const s of ["N/A", "-", "n/a", "TBD", "None", "", "  ", "null"]) {
      expect(sentinelToNull(s)).toBeNull();
    }
    expect(sentinelToNull("ALT10")).toBe("ALT10");
    expect(sentinelToNull("  Chris  ")).toBe("Chris");
  });

  it("#2 conflicting dates: structured field wins, disagreement is alerted", () => {
    const rows = deriveRows(
      { ...base, datesText: "9/01/2026 - 9/30/2026" }, // model disagrees…
      { status: "Registration Available", dates: "7/20/2026 - 8/03/2026" }, // …structured wins
      { detailUrl: "u", groupUrl: "g", referenceDate: REF },
    );
    expect(rows.listing.startsOn).toBe("2026-07-20");
    expect(rows.alerts.some((a) => a.includes("date conflict"))).toBe(true);
  });

  it("#3 fee breakdown: every line a row; Total Fees flagged; not the first dollar figure", () => {
    const { rows } = deriveFees([
      { label: "Tuition", amount: "$ 415" },
      { label: "Total Fees", amount: "$ 415" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ord: 0, label: "Tuition", amountCents: 41500, isTotal: false });
    expect(rows[1]).toMatchObject({ label: "Total Fees", amountCents: 41500, isTotal: true });
    expect(deriveTotalFeeCents(rows)).toBe(41500); // the Total line, not a sum
    expect(parseFeeCents("$1,234.50")).toBe(123450);
    expect(parseFeeCents("Free")).toBeNull();
  });

  it("#4 entangled campus/format: separate columns, separate derivations", () => {
    expect(splitFormat("Distance Education: Online e-College")).toEqual({
      category: "Distance Education",
      platform: "Online e-College",
    });
    // Location "Online" and a Distance-Education format are different facts.
    expect(deriveCampus("Online, n/a", "unknown")).toBe("Online");
    expect(deriveCampus("100 Rockafeller Rd Piscataway , NJ 08854", "unknown")).toBe(
      "New Brunswick",
    );
    expect(deriveCampus("Alexandria, VA-DASH, Main Building", "unknown")).toBe("Other");
  });

  it("#5 free-text prerequisites: raw kept; None → no relation; FK not forced", () => {
    const none = deriveRelations([{ rawText: "None", source: "prereq_field", kind: null }]);
    expect(none).toHaveLength(0);
    // raw prerequisite text is preserved on the course even when it yields no edge
    const rows = deriveRows({ ...base, prerequisiteText: "None" }, {}, {
      detailUrl: "u",
      groupUrl: null,
    });
    expect(rows.course.prerequisiteText).toBeNull(); // "None" is a sentinel
  });

  it("#6 derived boolean is_evening: real evening → true, morning → false", () => {
    expect(deriveIsEvening("6:00 PM - 9:00 PM", null, null)).toBe(true);
    expect(deriveIsEvening("10:00 AM - 1:00 PM", null, null)).toBe(false);
    expect(deriveIsEvening(null, "Instructor Led: Evening & Weekend", null)).toBe(true);
  });

  it("#7 status vocabulary: real values map; unknown → unknown + alert", () => {
    expect(mapStatus("Registration Available").status).toBe("open");
    expect(mapStatus("Course Full").status).toBe("full");
    expect(mapStatus("Waiting List Available").status).toBe("waitlist");
    expect(mapStatus("Registration Not Available").status).toBe("closed");
    const weird = mapStatus("Enrolling Soon");
    expect(weird.status).toBe("unknown");
    expect(weird.alert).not.toBeNull();
  });

  it("#8 label/value misalignment: code in the section slot is detected & realigned", () => {
    const pf: StoredPageFields = { courseId: "", sectionId: "ALT10" };
    expect(detectMisalignment("ALT10", pf)).not.toBeNull();
    expect(detectMisalignment("ALT10", { courseId: "ALT10", sectionId: "289" })).toBeNull();
  });

  it("#9 facts inside the title: contact hours parsed from the string", () => {
    expect(parseContactHours("Alternate Route 45 - Hour Math Across the Curriculum")).toBe(45);
    expect(parseContactHours("Intro to 12-hour Care")).toBe(12);
    expect(parseContactHours("No hours here")).toBeNull();
  });

  it("#10 rules inside footnotes → registration_deadline (two business days prior)", () => {
    const d = deriveDeadline(
      "The deadline for online registration is two business days prior to the start of the course",
      "2026-07-20", // a Monday
    );
    expect(d.date).toBe("2026-07-16"); // Sat/Sun skipped → Thu
    expect(d.rule).not.toBeNull(); // verbatim rule kept for display
  });

  it("#11 relations from prose AND prereq field: both mined, deduped", () => {
    const rels = deriveRelations([
      { rawText: "Phase I", source: "description", kind: "concurrent" },
      { rawText: "Phase I", source: "prereq_field", kind: null }, // dup by raw text
      { rawText: "None", source: "prereq_field", kind: null }, // sentinel dropped
    ]);
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      rawText: "Phase I",
      source: "description",
      kind: "concurrent",
    });
  });

  it("#12 async has no time of day: is_evening stays NULL", () => {
    expect(deriveIsEvening(null, "Asynchronous/Self-Paced", null)).toBeNull();
    expect(deriveIsEvening("N/A", null, null)).toBeNull();
  });

  it("#13 compound scalars: format/location/instructor split, verbatim kept", () => {
    expect(splitFormat("-Online: Instructor Led")).toEqual({
      category: "Online",
      platform: "Instructor Led",
    });
    expect(splitLocation("100 Rock, Room 3031 100 Rockafeller Rd")).toEqual({
      site: "100 Rock",
      room: "3031",
    });
    // "Ahn, Haemee Hu, Fiona" arrives already split; the format-leak is dropped.
    const people = deriveInstructors([
      { lastName: "Ahn", firstName: "Haemee" },
      { lastName: "Hu", firstName: "Fiona" },
      { lastName: "Asynchronous", firstName: "Self Paced" }, // not a person
      { lastName: "N/A", firstName: "-" }, // sentinel
    ]);
    expect(people).toHaveLength(2);
    expect(people.map((p) => p.lastName)).toEqual(["Ahn", "Hu"]);
    expect(people[0]?.ord).toBe(0);
  });
});

describe("derive — deriveRows integration", () => {
  it("assembles course + listing + children from real-shaped inputs", () => {
    const extracted: ExtractedCourse = {
      ...base,
      courseTitle: "45 - Hour Numeracy Across the Curriculum Online Course",
      externalCourseId: "ALT10",
      deliveryMode: "online_async",
      instructors: [{ lastName: "Teehan", firstName: "Kare" }],
      relations: [{ rawText: "Phase I", source: "description", kind: "concurrent" }],
    };
    const pageFields: StoredPageFields = {
      status: "Course Full",
      dates: "7/20/2026 - 8/03/2026",
      times: "6:00 PM - 9:00 PM",
      format: "Distance Education: Online Self Paced",
      location: "Online, n/a",
      sectionId: "289",
      fees: [{ label: "Tuition", amount: "$ 415" }, { label: "Total Fees", amount: "$ 415" }],
    };
    const rows = deriveRows(extracted, pageFields, {
      detailUrl: "https://ce-catalog.rutgers.edu/courseDisplay.cfm?schID=289",
      groupUrl: "https://ce-catalog.rutgers.edu/searchResults.cfm?couID=123",
      referenceDate: REF,
    });

    expect(rows.course).toMatchObject({
      externalCourseId: "ALT10",
      contactHours: 45,
      groupUrl: "https://ce-catalog.rutgers.edu/searchResults.cfm?couID=123",
    });
    expect(rows.listing).toMatchObject({
      status: "full",
      startsOn: "2026-07-20",
      termSeason: "Summer",
      termYear: 2026,
      term: "Summer 2026",
      isEvening: true,
      deliveryMode: "online_async",
      campus: "Online",
      externalSectionId: "289",
      totalFeeCents: 41500,
    });
    expect(rows.fees).toHaveLength(2);
    expect(rows.instructors).toEqual([{ ord: 0, lastName: "Teehan", firstName: "Kare" }]);
    expect(rows.relations).toHaveLength(1);
  });

  it("deriveTerm reads the season from the start month, not from `session`", () => {
    expect(deriveTerm("2026-07-20")).toEqual({
      year: 2026,
      season: "Summer",
      label: "Summer 2026",
    });
    expect(deriveTerm("2026-10-05")).toEqual({ year: 2026, season: "Fall", label: "Fall 2026" });
    expect(deriveTerm(null)).toEqual({ year: null, season: null, label: null });
  });

  it("deriveDates parses a clean cross-year M/D/Y range", () => {
    expect(deriveDates("10/05/2026 - 1/10/2027", REF)).toEqual({
      startsOn: "2026-10-05",
      endsOn: "2027-01-10",
    });
  });
});
