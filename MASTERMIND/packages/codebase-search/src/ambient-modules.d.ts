/**
 * Déclarations minimales pour que `tsc` compile même si la résolution Node16
 * ne trouve pas les types (hoisting workspaces, CI sans install complet, paquets sans .d.ts).
 * Les paquets restent des dépendances runtime réelles.
 */
declare module 'tree-sitter' {
  const TreeSitter: unknown;
  export default TreeSitter;
}

/* Langues tree-sitter : forme runtime variable selon les builds ; any suffit pour le chunker. */
declare module 'tree-sitter-typescript' {
  const m: Record<string, unknown>;
  export = m;
}

declare module 'tree-sitter-javascript' {
  const m: Record<string, unknown>;
  export = m;
}

declare module 'tree-sitter-python' {
  const m: Record<string, unknown>;
  export = m;
}

declare module 'glob' {
  export function glob(
    pattern: string | string[],
    options?: Record<string, unknown>,
  ): Promise<string[]>;
}

declare module 'chalk' {
  const chalk: {
    (s: string): string;
    green: (s: string) => string;
    red: (s: string) => string;
    yellow: (s: string) => string;
    blue: (s: string) => string;
    gray: (s: string) => string;
    cyan: (s: string) => string;
    white: (s: string) => string;
    bold: (s: string) => string;
  };
  export default chalk;
}

interface OraSpinner {
  start: (s?: string) => OraSpinner;
  stop: () => void;
  succeed: (s?: string) => void;
  fail: (s?: string) => void;
  text: string;
}

declare module 'ora' {
  export default function ora(options?: string | Record<string, unknown>): OraSpinner;
}

declare module '@lancedb/lancedb' {
  /** API LanceDB réelle plus riche ; `any` évite les frictions de typage sans les types du paquet. */
  export function connect(uri: string, opts?: Record<string, unknown>): Promise<any>;
}
