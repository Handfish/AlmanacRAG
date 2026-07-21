import * as cheerio from "cheerio";

// ── Deterministic field capture (§9 preview, but ZERO AI — Phase 1 stays
// non-generative). The ce-catalog detail page is a label/value <table>:
//   <tr><td><strong>Status</strong></td><td>Registration Available</td></tr>
// plus fee rows (<td>$ 149</td><td>Registration Fee</td>). We mirror that
// structure into a queryable JSON object so a RAG/analytics query can hit
// `page_fields->>'status'` immediately, alongside the full raw_markdown.
//
// This is a *faithful mirror*, not the typed schema. It does NOT normalize
// ("Fall- 2026" stays verbatim), derive (no registration_deadline date), or
// verify label/value alignment — the Course ID / Section ID pairing is captured
// in DOM order exactly as published, misalignment and all (§9.2). Phase 2's
// per-family Extractor (AI + eval) is what turns this into validated typed rows.

export interface Fee {
  readonly amount: string;
  readonly label: string;
}

export interface PageFields {
  readonly title: string | undefined;
  readonly fields: Record<string, string>;
  readonly fees: ReadonlyArray<Fee>;
}

// Known labels → stable camelCase keys; anything else is slugged generically so
// no field is ever dropped just because it wasn't anticipated.
const LABEL_KEY: Readonly<Record<string, string>> = {
  "status": "status",
  "course id": "courseId",
  "section id": "sectionId",
  "session": "session",
  "days": "days",
  "dates": "dates",
  "instructor": "instructor",
  "instructors": "instructor",
  "location": "location",
  "course prerequisites": "prerequisites",
  "prerequisites": "prerequisites",
  "audience": "audience",
  "refund policy": "refundPolicy",
  "format": "format",
  "registration deadline": "registrationDeadline",
};

const clean = (s: string): string => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

const keyFor = (label: string): string => {
  const norm = clean(label).toLowerCase();
  if (LABEL_KEY[norm]) return LABEL_KEY[norm];
  const words = norm.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  if (words.length === 0) return "field";
  return words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join("");
};

// A <strong> label may itself contain <br> ("Course<br>Prerequisites"); text()
// would glue the words. Convert <br> and any tags to spaces first.
const labelText = (html: string): string =>
  clean(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "));

// Split a value cell into parts on <br>, so a two-label cell (Course ID / Section
// ID) lines up index-for-index with its two values.
const cellParts = (cellHtml: string): Array<string> =>
  cheerio.load(cellHtml.replace(/<br\s*\/?>/gi, "\n"))("body")
    .text()
    .split("\n")
    .map(clean)
    .filter((s) => s.length > 0);

const FEE_AMOUNT = /^\$\s*[\d,]+(?:\.\d{2})?$/;

/** Parse the detail page's label/value table + fee rows into a faithful object. */
export const extractFields = (rawHtml: string): PageFields => {
  const $ = cheerio.load(rawHtml);
  const fields: Record<string, string> = {};
  const fees: Array<Fee> = [];

  $("tr").each((_, tr) => {
    const tds = $(tr).children("td");
    if (tds.length === 0) return;
    const labelCell = tds.eq(0);
    const strongs = labelCell.find("strong");

    if (strongs.length > 0 && tds.length > 1) {
      const valueCell = tds.eq(1);
      const labels = strongs.toArray()
        .map((s) => labelText($(s).html() ?? ""))
        .filter((l) => l.length > 0);

      // A bolded amount ("<strong>$ 250</strong> | Total Fees") is a fee line,
      // not a label/value pair — capture it as one so it doesn't become a stray
      // numeric key.
      if (labels.length === 1 && FEE_AMOUNT.test(labels[0]!)) {
        const feeLabel = clean(valueCell.text());
        if (feeLabel) fees.push({ amount: labels[0]!, label: feeLabel });
        return;
      }

      const parts = cellParts(valueCell.html() ?? "");
      if (labels.length > 1 && parts.length >= labels.length) {
        labels.forEach((label, i) => {
          const value = clean(parts[i] ?? "");
          if (label && value) fields[keyFor(label)] = value;
        });
      } else if (labels.length > 0) {
        const value = clean(valueCell.text());
        if (value) fields[keyFor(labels.join(" "))] = value;
      }
      return;
    }

    // A fee line: "$ 149" | "Registration Fee".
    const amount = clean(labelCell.text());
    if (FEE_AMOUNT.test(amount) && tds.length > 1) {
      const label = clean(tds.eq(1).text());
      if (label) fees.push({ amount, label });
    }
  });

  const title = clean($("h1").first().text()) || clean($("title").first().text());
  return { title: title.length > 0 ? title : undefined, fields, fees };
};
