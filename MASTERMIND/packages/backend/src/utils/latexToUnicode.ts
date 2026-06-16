/**
 * Replace simple LaTeX symbol commands ($\command$ or $\command{arg}$) with
 * their Unicode equivalents.  Only well-known single-symbol commands are
 * replaced — complex expressions like $\frac{a}{b}$ or $x^2$ are left as-is.
 *
 * Content inside fenced code blocks (```) and inline code (`) is preserved.
 */

const SYMBOL_MAP: Record<string, string> = {
  rightarrow: '→',
  leftarrow: '←',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  leftrightarrow: '↔',
  Leftrightarrow: '⇔',
  uparrow: '↑',
  downarrow: '↓',
  times: '×',
  div: '÷',
  pm: '±',
  mp: '∓',
  cdot: '·',
  bullet: '•',
  star: '⋆',
  leq: '≤',
  geq: '≥',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  propto: '∝',
  infty: '∞',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  omega: 'ω',
  Alpha: 'Α',
  Beta: 'Β',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Omega: 'Ω',
  sum: '∑',
  prod: '∏',
  int: '∫',
  partial: '∂',
  nabla: '∇',
  forall: '∀',
  exists: '∃',
  neg: '¬',
  land: '∧',
  lor: '∨',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  supset: '⊃',
  subseteq: '⊆',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  ldots: '…',
  dots: '…',
  cdots: '⋯',
  vdots: '⋮',
  ddots: '⋱',
  langle: '⟨',
  rangle: '⟩',
  ell: 'ℓ',
  hbar: 'ℏ',
  dagger: '†',
  ddagger: '‡',
  checkmark: '✓',
};

// Build a regex alternation of all known commands, longest-first to avoid prefix clashes
const COMMANDS = Object.keys(SYMBOL_MAP).sort((a, b) => b.length - a.length).join('|');

// Match $\command$ — a single known LaTeX command with no extra content
const SIMPLE_RE = new RegExp(`\\$\\\\(${COMMANDS})\\$`, 'g');

// Match $\sqrt{content}$ — sqrt with a braced argument
const SQRT_RE = /\$\\sqrt\{([^}]+)\}\$/g;

export function replaceLatexSymbols(text: string): string {
  // 1. Mask fenced code blocks and inline code so we don't replace inside them
  const masks: string[] = [];
  const mask = (m: string): string => {
    const idx = masks.length;
    masks.push(m);
    return `\x01LATEX_MASK_${idx}\x01`;
  };

  let out = text;

  // Mask fenced code blocks
  out = out.replace(/```[\s\S]*?```/g, mask);
  // Mask inline code
  out = out.replace(/`[^`\n]+`/g, mask);

  // 2. Replace simple symbol commands: $\rightarrow$ → →
  out = out.replace(SIMPLE_RE, (_m, cmd: string) => SYMBOL_MAP[cmd]);

  // 3. Replace $\sqrt{x}$ → √x
  out = out.replace(SQRT_RE, (_m, arg: string) => `√${arg}`);

  // 4. Restore masked code blocks
  out = out.replace(/\x01LATEX_MASK_(\d+)\x01/g, (_m, i: string) => masks[Number(i)]);

  return out;
}
