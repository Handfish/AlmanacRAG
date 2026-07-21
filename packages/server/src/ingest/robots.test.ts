import { describe, expect, it } from "@effect/vitest";
import { isPathAllowed, parseRobots } from "./robots.js";

// The live ce-catalog robots.txt (note the "# go away" comment). It disallows
// only the print variant and getAutoSponsor for everyone; XoviBot is fully out.
const CECC_ROBOTS = `# go away
User-agent: *
Disallow: /courseDisplay.cfm?schID=*&print=true
Disallow: /getAutoSponsor.cfm

User-agent: XoviBot
Disallow: /
`;

const UA = "CECC-Catalog-Recrawl/0.1";

describe("robots", () => {
  it("selects the * group for our UA, not XoviBot's blanket block", () => {
    const rules = parseRobots(CECC_ROBOTS, UA);
    expect(rules.disallow).toContain("/getAutoSponsor.cfm");
    expect(isPathAllowed("/", rules)).toBe(true); // XoviBot's `Disallow: /` must not apply to us
  });

  it("wildcard: the plain courseDisplay page is allowed, the print variant is not", () => {
    const rules = parseRobots(CECC_ROBOTS, UA);
    expect(isPathAllowed("/courseDisplay.cfm?schID=97766", rules)).toBe(true);
    expect(isPathAllowed("/courseDisplay.cfm?schID=97766&print=true", rules)).toBe(false);
    expect(isPathAllowed("/getAutoSponsor.cfm", rules)).toBe(false);
  });

  it("longest-match Allow overrides a broader Disallow", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n",
      UA,
    );
    expect(isPathAllowed("/wp-admin/settings", rules)).toBe(false);
    expect(isPathAllowed("/wp-admin/admin-ajax.php", rules)).toBe(true);
  });

  it("an empty ruleset (no robots) allows everything", () => {
    const rules = parseRobots("", UA);
    expect(isPathAllowed("/anything", rules)).toBe(true);
  });
});
