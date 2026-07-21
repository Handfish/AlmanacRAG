import * as Schema from "effect/Schema";

// Branded identifiers (architecture.md §5). External natural keys are strings;
// branding keeps a ListingId from being passed where a CourseId is expected.

export const ListingId = Schema.String.pipe(Schema.brand("ListingId"));
export type ListingId = typeof ListingId.Type;

export const CourseId = Schema.String.pipe(Schema.brand("CourseId"));
export type CourseId = typeof CourseId.Type;

export const UnitId = Schema.String.pipe(Schema.brand("UnitId"));
export type UnitId = typeof UnitId.Type;

export const ChunkId = Schema.String.pipe(Schema.brand("ChunkId"));
export type ChunkId = typeof ChunkId.Type;
