import { describe, expect, it } from "@effect/vitest";
import { detailHtml, indexHtml } from "@test/fixtures";
import { analyzePage, extractGroupUrl, extractLinks, htmlToMarkdown } from "./segment.js";

const BASE = "https://ce-catalog.rutgers.edu/courseDisplay.cfm?schID=97766";

describe("segment", () => {
  it("htmlToMarkdown keeps all detail facts but drops site chrome", () => {
    const md = htmlToMarkdown(detailHtml());
    expect(md).toContain("Registration Available");
    expect(md).toContain("Total Fees");
    expect(md).toContain("multiplying and dividing fractions");
    // scoped to [role=main]: nav/footer boilerplate excluded (stable hashing)
    expect(md).not.toContain("Global nav");
    expect(md).not.toContain("Identical footer");
  });

  it("extractGroupUrl resolves the 'More offerings like this' image link (couID)", () => {
    const url = extractGroupUrl(detailHtml(), BASE);
    expect(url).toBeDefined();
    expect(url).toContain("searchResults.cfm?couID="); // authoritative course id (§5.2.6)
    expect(url!.startsWith("https://ce-catalog.rutgers.edu/")).toBe(true);
  });

  it("extractGroupUrl returns undefined when the link is absent", () => {
    expect(extractGroupUrl("<html><body><a href='/x'>Home</a></body></html>", BASE))
      .toBeUndefined();
  });

  it("extractLinks pulls a.chart detail links, ignoring other anchors", () => {
    const links = extractLinks(indexHtml([11, 22, 33]), BASE, "a.chart");
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.includes("courseDisplay.cfm?schID="))).toBe(true);
    expect(links.some((l) => l.includes("search.cfm"))).toBe(false);
  });

  // The crown jewel (§5.1): segmented hashing isolates the two lifetimes.
  it("segmented hashing: a status flip moves listing_hash, not course_hash", () => {
    const open = detailHtml({ status: "Registration Available" });
    const full = detailHtml({ status: "Course Full" });
    const a = analyzePage(open, htmlToMarkdown(open), BASE);
    const b = analyzePage(full, htmlToMarkdown(full), BASE);
    expect(a.courseHash).toBe(b.courseHash); // description didn't move
    expect(a.listingHash).not.toBe(b.listingHash); // status did
  });

  it("segmented hashing: a description edit moves course_hash, not listing_hash", () => {
    const base = detailHtml();
    const edited = detailHtml({
      description: "A completely different course about astrophysics and quantum field theory.",
    });
    const a = analyzePage(base, htmlToMarkdown(base), BASE);
    const b = analyzePage(edited, htmlToMarkdown(edited), BASE);
    expect(a.listingHash).toBe(b.listingHash); // term/status/fees unchanged
    expect(a.courseHash).not.toBe(b.courseHash); // prose changed
  });
});
