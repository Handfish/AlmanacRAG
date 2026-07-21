// Vite/vitest augment `import.meta` with `glob` (used by the test migration
// loader, `Migrator.fromGlob`). tsc doesn't know it natively.
interface ImportMeta {
  glob(pattern: string): Record<string, () => Promise<unknown>>;
}
