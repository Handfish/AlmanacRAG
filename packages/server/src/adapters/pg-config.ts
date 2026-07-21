import * as Str from "effect/String";
import * as Pg from "pg";

// Shared PgClient config for both SQL layers (ADR-I5). camelCase ⇄ snake_case at
// the query/result boundary, and a type-parser that leaves TIMESTAMP/TIMESTAMPTZ
// (oids 1114 / 1184) as raw strings so `effect/Schema` decodes them, not node-pg.
export const pgConfig = {
  transformQueryNames: Str.camelToSnake,
  transformResultNames: Str.snakeToCamel,
  transformJson: true,
  types: {
    getTypeParser: (oid: number, format?: string) => {
      if (oid === 1114 || oid === 1184) {
        return (val: string) => val;
      }
      return Pg.types.getTypeParser(oid, format as never);
    },
  },
} as const;
