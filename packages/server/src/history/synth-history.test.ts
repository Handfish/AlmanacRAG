import { describe, expect, it } from "@effect/vitest";
import {
  archetypeFor,
  balancedArchetype,
  planSyntheticHistory,
  type SeedCourse,
  synthUuid,
} from "./synth-history.js";

// The synthetic-history generator is a deterministic fixture (no clock, no randomness), so
// it unit-tests exactly: same seeds → same plan, archetypes control term coverage, and fees
// drift monotonically below the current price so "has it gotten more expensive?" has a real
// answer. These tests pin the shape the integration test then loads into Postgres.

const seed = (
  id: string,
  season: SeedCourse["season"],
  year: number,
  fee: number | null,
): SeedCourse => ({
  courseId: id,
  courseTitle: `Course ${id}`,
  season,
  year,
  feeCents: fee,
  campus: "Newark",
  deliveryMode: "in_person",
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

describe("synth-history generator", () => {
  it("synthUuid is a stable, valid uuid derived from the seed", () => {
    expect(synthUuid("a:Fall 2024")).toMatch(UUID_RE);
    expect(synthUuid("a:Fall 2024")).toBe(synthUuid("a:Fall 2024")); // deterministic
    expect(synthUuid("a:Fall 2024")).not.toBe(synthUuid("a:Fall 2023"));
  });

  it("archetypeFor is deterministic and spans all three archetypes across ids", () => {
    const seen = new Set(
      Array.from({ length: 60 }, (_, i) => archetypeFor(`course-${i}`)),
    );
    expect(seen).toEqual(new Set(["recurring", "returning", "current_only"]));
    expect(archetypeFor("course-1")).toBe(archetypeFor("course-1"));
  });

  it("balanced coverage: recurring → +2 prior terms, returning → +1, current_only → +0", () => {
    const seeds = [
      seed("A", "Fall", 2026, 45000),
      seed("B", "Fall", 2026, 30000),
      seed("C", "Fall", 2026, 10000),
    ];
    const plan = planSyntheticHistory(seeds, {
      assignArchetype: balancedArchetype(seeds.map((s) => s.courseId)),
    });
    const byCourse = (id: string) => plan.listings.filter((l) => l.courseId === id);
    expect(plan.assignments.map((a) => a.archetype)).toEqual([
      "recurring",
      "returning",
      "current_only",
    ]);
    expect(byCourse("A")).toHaveLength(2); // Fall 2025 + Fall 2024
    expect(byCourse("B")).toHaveLength(1); // Fall 2024 (a gap year)
    expect(byCourse("C")).toHaveLength(0); // stays n=1
  });

  it("prior-term fees drift below the current price, monotonically", () => {
    const seeds = [seed("A", "Fall", 2026, 45000)];
    const plan = planSyntheticHistory(seeds, {
      assignArchetype: () => "recurring",
    });
    const byYear = new Map(plan.listings.map((l) => [l.termYear, l.totalFeeCents]));
    expect(byYear.get(2025)!).toBeLessThan(45000);
    expect(byYear.get(2024)!).toBeLessThan(byYear.get(2025)!);
    // every prior listing is disappeared (a past term isn't currently listed) and closed
    for (const l of plan.listings) {
      expect(l.disappearedAt).not.toBeNull();
      expect(l.status).toBe("closed");
      expect(l.detailUrl.startsWith("synthetic://")).toBe(true);
    }
  });

  it("carries a change log (status arc + fee increase) and moves the window back", () => {
    const seeds = [seed("A", "Fall", 2026, 45000)];
    const plan = planSyntheticHistory(seeds, { assignArchetype: () => "recurring" });
    const fields = new Set(plan.listings.flatMap((l) => l.changes.map((c) => c.field)));
    expect(fields).toContain("status");
    expect(fields).toContain("total_fee_cents");
    // observingSince is the earliest fabricated term start (Fall 2024)
    expect(plan.observingSince.startsWith("2024-09")).toBe(true);
  });

  it("a null current fee produces null past fees (never fabricates a number)", () => {
    const plan = planSyntheticHistory([seed("A", "Summer", 2026, null)], {
      assignArchetype: () => "recurring",
    });
    for (const l of plan.listings) expect(l.totalFeeCents).toBeNull();
  });
});
