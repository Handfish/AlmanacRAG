// Build the embeddable/searchable text for a course chunk (architecture.md §5.4/§7).
// PURE — no AI, no DB. Chunks hang off `course` only, so the text is the course's
// semantic surface (title + description + the facts a searcher reasons over in prose:
// subject, track, program, audience, prerequisites). Typed listing facts — dates,
// fees, campus, status — are deliberately NOT here: they belong to `filter_listings`
// (§5.4), and mixing them in would pull volatile per-section values into an embedding
// that should stay stable across a course's sections.

export interface CourseChunkSource {
  readonly courseTitle: string;
  readonly subject: string | null;
  readonly track: string | null;
  readonly program: string | null;
  readonly audience: string | null;
  readonly description: string | null;
  readonly prerequisiteText: string | null; // already sentinel-cleaned in derive (null if "None")
  readonly contactHours: number | null;
}

const SMALLINT_MAX = 32767;

/** ~4 chars/token is the usual English rule of thumb; clamped to the smallint column. */
export const estimateTokens = (text: string): number =>
  Math.min(SMALLINT_MAX, Math.max(1, Math.ceil(text.length / 4)));

export const buildChunkText = (course: CourseChunkSource): string => {
  const lines: Array<string> = [course.courseTitle.trim()];

  const meta = [
    course.subject && `Subject: ${course.subject}`,
    course.track && `Track: ${course.track}`,
    course.program && `Program: ${course.program}`,
    course.contactHours != null && `Contact hours: ${course.contactHours}`,
  ].filter((x): x is string => typeof x === "string");
  if (meta.length > 0) lines.push(meta.join(" · "));

  if (course.description) lines.push(course.description.trim());
  if (course.audience) lines.push(`Audience: ${course.audience.trim()}`);
  if (course.prerequisiteText) lines.push(`Prerequisites: ${course.prerequisiteText.trim()}`);

  return lines.join("\n");
};
