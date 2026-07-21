import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FETCH_TIMEOUT_MS, USER_AGENT } from "./consts.js";

// ── robots.txt politeness (ADR-002 / §6.1). We re-fetch our own institution's
// site, but we still ask first. Rules are fetched once per origin, cached for
// the run, and consulted by the crawl orchestrator before any URL is enqueued.
// Fail-open: an unreachable or malformed robots.txt does not block the crawl (a
// bad robots fetch should not silently declare the whole site off-limits), but
// an explicit Disallow is honoured.

export interface Rules {
  readonly allow: ReadonlyArray<string>;
  readonly disallow: ReadonlyArray<string>;
}

const ALLOW_ALL: Rules = { allow: [], disallow: [] };

/**
 * Parse robots.txt, selecting the most specific group whose user-agent token our
 * `USER_AGENT` matches, else the `*` group. Comments and blank lines are ignored;
 * an empty `Disallow:` value (meaning "allow everything") is dropped.
 */
export const parseRobots = (text: string, userAgent: string): Rules => {
  const groups = new Map<string, { allow: Array<string>; disallow: Array<string>; }>();
  let current: Array<string> = [];
  let sawRuleSinceAgent = false;

  const ensure = (ua: string) => {
    let g = groups.get(ua);
    if (!g) {
      g = { allow: [], disallow: [] };
      groups.set(ua, g);
    }
    return g;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (sawRuleSinceAgent) {
        current = [];
        sawRuleSinceAgent = false;
      }
      const ua = value.toLowerCase();
      current.push(ua);
      ensure(ua);
    } else if (key === "disallow" || key === "allow") {
      sawRuleSinceAgent = true;
      if (value === "") continue;
      for (const ua of current) {
        if (key === "disallow") ensure(ua).disallow.push(value);
        else ensure(ua).allow.push(value);
      }
    }
  }

  // Most specific matching agent group wins; fall back to `*`.
  const uaLower = userAgent.toLowerCase();
  let best: string | undefined;
  for (const ua of groups.keys()) {
    if (ua === "*") {
      best ??= "*";
    } else if (
      uaLower.includes(ua) && (best === undefined || best === "*" || ua.length > best.length)
    ) {
      best = ua;
    }
  }
  const chosen = best !== undefined ? groups.get(best) : undefined;
  return chosen ?? ALLOW_ALL;
};

// Compile a robots path pattern to a regex: `*` = any run, trailing `$` = end
// anchor, everything else literal. So `/courseDisplay.cfm?schID=*&print=true`
// disallows only the print variant — the plain `?schID=NNN` pages stay allowed.
const patternToRegex = (pattern: string): RegExp => {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re);
};

const matchLen = (pattern: string, path: string): number =>
  patternToRegex(pattern).test(path) ? pattern.length : -1;

/** Longest-match rule wins; Allow ties beat Disallow (robots convention). */
export const isPathAllowed = (pathAndQuery: string, rules: Rules): boolean => {
  const longest = (patterns: ReadonlyArray<string>): number =>
    patterns.reduce((max, p) => Math.max(max, matchLen(p, pathAndQuery)), -1);
  const dis = longest(rules.disallow);
  if (dis === -1) return true;
  return longest(rules.allow) >= dis;
};

const fetchRules = (origin: string): Effect.Effect<Rules> =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal }),
    catch: (cause) => cause,
  }).pipe(
    Effect.timeout(Duration.millis(FETCH_TIMEOUT_MS)),
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.promise(() => res.text()).pipe(Effect.map((t) => parseRobots(t, USER_AGENT)))
        : Effect.succeed(ALLOW_ALL)
    ),
    Effect.orElseSucceed(() => ALLOW_ALL),
  );

export type RobotsShape = {
  readonly isAllowed: (url: string) => Effect.Effect<boolean>;
};

export class Robots extends Context.Service<Robots, RobotsShape>()("catalog/Robots") {
  static Default = Layer.effect(
    Robots,
    Effect.sync(() => {
      const cache = new Map<string, Rules>();
      return {
        isAllowed: (url: string) =>
          Effect.gen(function*() {
            let origin: string;
            let pathAndQuery: string;
            try {
              const u = new URL(url);
              origin = u.origin;
              pathAndQuery = u.pathname + u.search;
            } catch {
              return true; // let the fetch itself fail on a bad URL
            }
            let rules = cache.get(origin);
            if (!rules) {
              rules = yield* fetchRules(origin);
              cache.set(origin, rules);
            }
            return isPathAllowed(pathAndQuery, rules);
          }),
      };
    }),
  );
}
