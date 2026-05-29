// Ambient declarations for non-code side-effect imports.
//
// TypeScript 6 reports TS2882 for side-effect imports of modules it can't
// resolve to a type (e.g. `import '@libriant/ui/styles.css'`). Next.js
// handles the actual CSS at build time; this declaration just satisfies
// `tsc --noEmit`.
declare module '*.css';
