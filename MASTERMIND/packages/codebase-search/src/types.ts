export interface Config {
  /** Extensions de fichiers à indexer */
  extensions: string[];
  /** Dossiers à exclure */
  excludeDirs: string[];
  /** Fichiers à exclure (patterns) */
  excludeFiles: string[];
  /** Taille des chunks (caractères) */
  chunkSize: number;
  /** Chevauchement entre chunks (caractères) */
  chunkOverlap: number;
  /** Modèle d'embeddings (OpenRouter/OpenAI compatible) */
  embeddingModel: string;
  /** Dimensions des embeddings */
  embeddingDimensions: number;
  /** Nombre max de fichiers à indexer en parallèle */
  maxConcurrentFiles: number;
  /** Utiliser Tree-sitter pour le parsing */
  useTreeSitter: boolean;
  /** Nombre de candidats récupérés avant reranking */
  candidatePool: number;
  /** Nombre de candidats rerankés finement */
  rerankTopK: number;
  /** Poids de similarité vectorielle dans le score hybride */
  vectorWeight: number;
  /** Poids lexical dans le score hybride */
  lexicalWeight: number;
  /** Poids structurel (type/symbole) dans le score hybride */
  structuralWeight: number;
  /** Activer le log du détail des scores */
  debugScoring: boolean;
  /** URL de base de l'API d'embedding (OpenAI-compatible) */
  baseUrl?: string;
  /** Clé API (fallback si OPENROUTER_API_KEY / OPENAI_API_KEY non définie) */
  apiKey?: string;
}

export interface CodeChunk {
  /** ID unique du chunk */
  id: string;
  /** Chemin du fichier */
  filePath: string;
  /** Nom du fichier */
  fileName: string;
  /** Extension du fichier */
  extension: string;
  /** Contenu du chunk */
  content: string;
  /** Numéro de ligne de début */
  startLine: number;
  /** Numéro de ligne de fin */
  endLine: number;
  /** Type de chunk (function, class, interface, etc.) */
  type?: string;
  /** Nom de l'entité (fonction, classe, etc.) */
  name?: string;
  /** Contexte du chunk (imports, déclarations précédentes) */
  context?: string;
  /** Last filesystem mtime at indexing time, used for incremental freshness checks */
  fileMtimeMs?: number;
}

export interface IndexedChunk extends CodeChunk {
  /** Embedding vector */
  vector: number[];
  /** Date d'indexation */
  indexedAt: string;
}

export interface SearchResult {
  /** Chunk trouvé */
  chunk: CodeChunk;
  /** Score de similarité */
  score: number;
}

export interface SearchOptions {
  /** Requête textuelle */
  query: string;
  /** Nombre de résultats */
  limit?: number;
  /** Filtre sur les extensions */
  extensions?: string[];
  /** Filtre sur les chemins de fichiers */
  filePattern?: string;
  /** Type de recherche: 'vector' | 'hybrid' */
  type?: 'vector' | 'hybrid';
  /** Poids du nom de fichier en recherche hybride (0-1) */
  fileNameWeight?: number;
  /** Taille du pool candidat avant tri final */
  candidatePool?: number;
  /** Taille du pool reranké localement */
  rerankTopK?: number;
  /** Prioriser les correspondances exactes de symboles */
  exactSymbol?: boolean;
  /** Si true, pas de spinner CLI (usage serveur / bibliothèque) */
  silent?: boolean;
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  totalSize: number;
  extensions: Record<string, number>;
  indexedAt: string;
}

export const DEFAULT_CONFIG: Config = {
  extensions: [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.pyx', '.pyi',
    '.cs', '.csx',
    '.java', '.kt', '.scala',
    '.go', '.rs', '.rb', '.php',
    '.swift', '.m', '.mm',
    '.c', '.cpp', '.cc', '.h', '.hpp',
    '.sql', '.prisma', '.graphql',
    '.json', '.yaml', '.yml', '.toml',
    '.md', '.mdx', '.rst',
    '.sh', '.bash', '.zsh', '.ps1',
    '.dockerfile', '.tf', '.hcl'
  ],
  excludeDirs: [
    'node_modules', '.git', '.svn', '.hg',
    'build', 'dist', 'out', 'target',
    '.next', '.nuxt', '.output',
    'coverage', '.coverage', 'htmlcov',
    'vendor', 'venv', '.venv', '__pycache__',
    '.idea', '.vscode', '.vs',
    'logs', 'tmp', 'temp', '.tmp',
    'bin', 'obj', '.gradle', '.mvn'
  ],
  excludeFiles: [
    '*.min.js', '*.min.css', '*.bundle.js',
    '*.map', '*.lock', 'package-lock.json',
    '*.pyc', '*.pyo', '*.class',
    '*.o', '*.a', '*.so', '*.dll', '*.exe',
    '*.log', '*.pid', '*.seed', '*.pid.lock',
    '.DS_Store', 'Thumbs.db', 'desktop.ini'
  ],
  chunkSize: 1500,
  chunkOverlap: 200,
  baseUrl: 'https://openrouter.ai/api/v1/embeddings',
  embeddingModel: 'qwen/qwen3-embedding-8b',
  embeddingDimensions: 4096,
  maxConcurrentFiles: 50,
  useTreeSitter: true,
  candidatePool: 80,
  rerankTopK: 30,
  vectorWeight: 0.55,
  lexicalWeight: 0.3,
  structuralWeight: 0.15,
  debugScoring: false
};
