import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Config, DEFAULT_CONFIG } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mastermindEnvLoaded = false;
function loadMastermindEnv(): void {
  if (mastermindEnvLoaded) return;
  mastermindEnvLoaded = true;
  const envPath = join(homedir(), '.mastermind', '.env');
  dotenv.config({ path: envPath });
}

const CONFIG_PATHS = [
  join(__dirname, '..', 'codebase-search.config.json'),
  join(__dirname, '..', '.codebase-search.json'),
  'codebase-search.config.json',
  '.codebase-search.json',
  join(process.env.HOME || '~', '.config', 'codebase-search', 'config.json')
];

export async function loadConfig(customPath?: string): Promise<Config> {
  loadMastermindEnv();
  const paths = customPath ? [customPath] : CONFIG_PATHS;
  
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = await readFile(path, 'utf-8');
        const userConfig = JSON.parse(content);
        return { ...DEFAULT_CONFIG, ...userConfig };
      } catch (error) {
        console.warn(`⚠️  Erreur lors du chargement de ${path}:`, error);
      }
    }
  }
  
  return DEFAULT_CONFIG;
}

export interface ValidateConfigOptions {
  /** Exiger une clé API embeddings (désactiver pour lecture seule LanceDB, ex. stats) */
  requireApiKey?: boolean;
}

export function validateConfig(config: Config, opts: ValidateConfigOptions = {}): void {
  const requireApiKey = opts.requireApiKey !== false;
  if (!config.extensions || config.extensions.length === 0) {
    throw new Error('Au moins une extension doit être spécifiée');
  }
  if (config.chunkSize <= 0) {
    throw new Error('chunkSize doit être positif');
  }
  if (config.chunkOverlap < 0 || config.chunkOverlap >= config.chunkSize) {
    throw new Error('chunkOverlap doit être entre 0 et chunkSize');
  }
  if (config.candidatePool <= 0) {
    throw new Error('candidatePool doit être positif');
  }
  if (config.rerankTopK <= 0) {
    throw new Error('rerankTopK doit être positif');
  }
  if (config.rerankTopK > config.candidatePool) {
    throw new Error('rerankTopK doit être <= candidatePool');
  }
  if (config.vectorWeight < 0 || config.lexicalWeight < 0 || config.structuralWeight < 0) {
    throw new Error('vectorWeight/lexicalWeight/structuralWeight doivent être >= 0');
  }
  if (requireApiKey) {
    // Mode broker (Mercury) : config.apiKey === '' explicitement + baseUrl non vide → broker gère l'auth.
    const brokerMode = config.apiKey === '' && Boolean(config.baseUrl);
    if (!brokerMode && !process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY && !config.apiKey) {
      throw new Error('OPENROUTER_API_KEY/OPENAI_API_KEY (env) ou apiKey (config) requis');
    }
  }
}

export function createDefaultConfig(path: string): Promise<void> {
  const config = JSON.stringify(DEFAULT_CONFIG, null, 2);
  return writeFile(path, config, 'utf-8');
}
