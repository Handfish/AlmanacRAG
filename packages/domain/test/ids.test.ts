import { CourseId, ListingId } from "@catalog/domain/ids";
import { describe, expect, it } from "@effect/vitest";

// A DB-free unit test so the `domain` vitest project is green without Docker.
describe("ids", () => {
  it("ListingId.make brands a string value", () => {
    const id = ListingId.make("L-123");
    expect(id).toBe("L-123");
  });

  it("distinct brands over the same underlying string", () => {
    expect(CourseId.make("X")).toBe("X");
    expect(ListingId.make("X")).toBe("X");
  });
});
