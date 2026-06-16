#!/usr/bin/env node

import { homedir } from 'os';
import { join, resolve } from 'path';
import { readdir, stat } from 'fs/promises';
import { glob } from 'glob';
import { Command } from 'commander';

/** Options renvoyées par commander (évite une dépendance à un export de types variable). */
type CmdOpts = Record<string, unknown>;

function optConfigPath(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  return undefined;
}
import chalk from 'chalk';
import ora from 'ora';
import * as lancedb from '@lancedb/lancedb';
import { writeFile, mkdir } from 'fs/promises';
import { loadConfig, validateConfig } from './config.js';
import { CodebaseIndexer } from './indexer.js';
import { CodebaseSearcher } from './searcher.js';
import { createDefaultConfig } from './config.js';

const DEFAULT_DB_PATH = join(homedir(), 'embed');
const EMBED_ROOT = join(homedir(), 'embed');

function commonSourceRoot(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const sorted = [...paths].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let i = 0;
  while (i < first.length && i < last.length && first[i] === last[i]) i++;
  let prefix = first.slice(0, i);
  const lastSlash = prefix.lastIndexOf('/');
  if (lastSlash > 0) prefix = prefix.slice(0, lastSlash);
  else if (lastSlash === 0) prefix = '/';
  return prefix || null;
}

const program = new Command();

program
  .name('codebase-search')
  .description('Système d\'indexation de codebase avec vector search')
  .version('1.0.0');

program
  .command('help')
  .description('Afficher l\'aide et lister les commandes')
  .action(() => {
    program.outputHelp();
  });

program
  .command('list')
  .description('Lister les répertoires d\'index (codebases) connus')
  .option('-r, --root <path>', 'Racine des index (défaut: ~/embed)', EMBED_ROOT)
  .action(async (options: CmdOpts) => {
    try {
      const root = String(options.root ?? EMBED_ROOT).replace(/^~/, homedir());
      const config = await loadConfig(undefined);
      const entries: { path: string; chunks: number }[] = [];

      async function checkPath(dbPath: string): Promise<boolean> {
        try {
          const db = await lancedb.connect(dbPath);
          const names = await db.tableNames();
          if (names.includes('codebase')) {
            const searcher = new CodebaseSearcher(config, dbPath);
            await searcher.initialize();
            const st = await searcher.getStats();
            entries.push({ path: dbPath, chunks: st.totalChunks });
            return true;
          }
        } catch {
          // pas un index valide
        }
        return false;
      }

      // Index à la racine (~/embed)
      await checkPath(root);

      try {
        const dirs = await readdir(root, { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory() || d.name.startsWith('.')) continue;
          const subPath = join(root, d.name);
          await checkPath(subPath);
        }
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }

      if (entries.length === 0) {
        console.log(chalk.yellow('Aucun index trouvé. Utilisez "codebase-search index <répertoire>" pour en créer un.'));
        console.log(chalk.gray(`Racine scannée: ${root}`));
        process.exit(0);
        return;
      }

      console.log(chalk.blue('\nRépertoires d\'index (codebases):\n'));
      const maxPath = Math.max(...entries.map((e) => e.path.length), 20);
      for (const e of entries) {
        console.log(`  ${e.path.padEnd(maxPath)}  ${chalk.gray(`${e.chunks} chunks`)}`);
      }
      console.log(chalk.gray(`\nUtilisez -d <path> avec search/stats pour cibler un index.`));
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('\n❌ Erreur:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('index')
  .description('Indexer une codebase')
  .argument('<path>', 'Chemin vers le répertoire à indexer')
  .option('-c, --config <path>', 'Chemin vers le fichier de configuration')
  .option('-d, --db <path>', 'Chemin vers la base de données LanceDB', DEFAULT_DB_PATH)
  .option('--no-tree-sitter', 'Désactiver Tree-sitter')
  .action(async (path: string, options: CmdOpts) => {
    try {
      const config = await loadConfig(optConfigPath(options.config));
      
      if (options.noTreeSitter) {
        config.useTreeSitter = false;
      }
      
      validateConfig(config);
      
      const indexer = new CodebaseIndexer(config, String(options.db ?? DEFAULT_DB_PATH));
      await indexer.initialize();
      
      const stats = await indexer.indexDirectory(path);
      indexer.printStats();
      
      console.log(chalk.green('\n✅ Indexation terminée avec succès!'));
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('\n❌ Erreur:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('embed')
  .description('Indexer ou mettre à jour les embeddings d\'un répertoire (alias pratique pour rafraîchir un index)')
  .argument('<path>', 'Chemin vers le répertoire à indexer')
  .option('-c, --config <path>', 'Chemin vers le fichier de configuration')
  .option('-d, --db <path>', 'Chemin vers la base de données LanceDB', DEFAULT_DB_PATH)
  .option('--no-tree-sitter', 'Désactiver Tree-sitter')
  .action(async (path: string, options: CmdOpts) => {
    try {
      const config = await loadConfig(optConfigPath(options.config));
      if (options.noTreeSitter) config.useTreeSitter = false;
      validateConfig(config);
      const indexer = new CodebaseIndexer(config, String(options.db ?? DEFAULT_DB_PATH));
      await indexer.initialize();
      await indexer.indexDirectory(path);
      indexer.printStats();
      console.log(chalk.green('\n✅ Embeddings à jour.'));
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('\n❌ Erreur:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Mettre à jour tous les index en mode incrémental (ou un seul si -d et path fournis)')
  .argument('[path]', 'Répertoire source (optionnel : si absent, met à jour tous les index sous ~/embed)')
  .option('-c, --config <path>', 'Chemin vers le fichier de configuration')
  .option('-d, --db <path>', 'Index à mettre à jour (défaut: tous si pas de path)', DEFAULT_DB_PATH)
  .option('-r, --root <path>', 'Racine des index à scanner (avec update sans path)', EMBED_ROOT)
  .option('--no-tree-sitter', 'Désactiver Tree-sitter pour les nouveaux fichiers')
  .action(async (pathArg: string | undefined, options: CmdOpts) => {
    try {
      const config = await loadConfig(optConfigPath(options.config));
      if (options.treeSitter === false) config.useTreeSitter = false;
      validateConfig(config);

      type IndexTarget = { dbPath: string; sourceDir: string };
      const targets: IndexTarget[] = [];

      if (pathArg) {
        targets.push({
          dbPath: String(options.db ?? DEFAULT_DB_PATH),
          sourceDir: resolve(pathArg),
        });
      } else {
        const root = (options.root as string).replace(/^~/, homedir());
        const dbPaths: string[] = [];
        try {
          const db = await lancedb.connect(root);
          const names = await db.tableNames();
          if (names.includes('codebase')) dbPaths.push(root);
        } catch {
          // pas un index
        }
        try {
          const dirs = await readdir(root, { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory() || d.name.startsWith('.')) continue;
            const subPath = join(root, d.name);
            try {
              const db = await lancedb.connect(subPath);
              const names = await db.tableNames();
              if (names.includes('codebase')) dbPaths.push(subPath);
            } catch {
              // skip
            }
          }
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
        }
        if (dbPaths.length === 0) {
          console.log(chalk.yellow('Aucun index trouvé sous ' + root + '. Utilisez "codebase-search index <path>" ou "codebase-search update <path>".'));
          process.exit(0);
          return;
        }
        for (const dbPath of dbPaths) {
          let indexedPaths: Set<string>;
          try {
            const searcher = new CodebaseSearcher(config, dbPath);
            await searcher.initialize();
            indexedPaths = await searcher.getIndexedFilePaths();
          } catch {
            continue;
          }
          const sourceDir = commonSourceRoot([...indexedPaths]);
          if (sourceDir) targets.push({ dbPath, sourceDir });
        }
        if (targets.length === 0) {
          console.log(chalk.yellow('Aucun index avec chemins valides (index vides ou corrompus).'));
          process.exit(0);
          return;
        }
      }

      for (const { dbPath, sourceDir } of targets) {
        let indexedMetadata: Map<string, number>;
        try {
          const metadataIndexer = new CodebaseIndexer(config, dbPath, { silent: true });
          await metadataIndexer.initialize();
          indexedMetadata = await metadataIndexer.getIndexedFileMetadata();
        } catch {
          indexedMetadata = new Map();
        }
        const indexedPaths = new Set(indexedMetadata.keys());
        const ignorePatterns = [
          ...config.excludeDirs.map((d) => `**/${d}/**`),
          ...config.excludeFiles
        ];
        const extensionsPattern = config.extensions.length === 1
          ? `**/*${config.extensions[0]}`
          : `**/*{${config.extensions.join(',')}}`;
        const sourceFiles = await glob(extensionsPattern, {
          cwd: sourceDir,
          absolute: true,
          ignore: ignorePatterns,
          nodir: true
        });
        const sourceSet = new Set(sourceFiles);
        const newFiles = sourceFiles.filter((f: string) => !indexedPaths.has(f));
        const removedFiles = [...indexedPaths].filter((f: string) => !sourceSet.has(f));
        const currentMtimes = new Map<string, number>();
        for (const file of sourceFiles) {
          try {
            currentMtimes.set(file, Math.floor((await stat(file)).mtimeMs));
          } catch {
            currentMtimes.set(file, 0);
          }
        }
        const modifiedFiles = sourceFiles.filter((f: string) =>
          indexedPaths.has(f) && (indexedMetadata.get(f) ?? 0) !== (currentMtimes.get(f) ?? 0),
        );
        if (newFiles.length === 0 && removedFiles.length === 0 && modifiedFiles.length === 0) {
          if (targets.length > 1) console.log(chalk.gray(`  [${dbPath}] `) + chalk.green('à jour'));
          else console.log(chalk.green('Index à jour avec le répertoire source.'));
          continue;
        }
        if (targets.length > 1) console.log(chalk.blue(`\n▶ ${dbPath}\n`));
        else console.log(chalk.blue('Mise à jour incrémentale de l\'index…\n'));
        if (removedFiles.length > 0) {
          console.log(chalk.yellow(`  Fichiers retirés du source (${removedFiles.length}) : suppression de l'index`));
          removedFiles.slice(0, 10).forEach((f) => console.log(chalk.gray(`    - ${f}`)));
          if (removedFiles.length > 10) console.log(chalk.gray(`    ... et ${removedFiles.length - 10} autres`));
          console.log();
        }
        if (newFiles.length > 0) {
          console.log(chalk.yellow(`  Nouveaux fichiers à indexer (${newFiles.length}) :`));
          newFiles.slice(0, 10).forEach((f: string) => console.log(chalk.gray(`    + ${f}`)));
          if (newFiles.length > 10) console.log(chalk.gray(`    ... et ${newFiles.length - 10} autres`));
          console.log();
        }
        if (modifiedFiles.length > 0) {
          console.log(chalk.yellow(`  Fichiers modifiés à réindexer (${modifiedFiles.length}) :`));
          modifiedFiles.slice(0, 10).forEach((f: string) => console.log(chalk.gray(`    * ${f}`)));
          if (modifiedFiles.length > 10) console.log(chalk.gray(`    ... et ${modifiedFiles.length - 10} autres`));
          console.log();
        }
        const indexer = new CodebaseIndexer(config, dbPath);
        await indexer.initialize();
        const result = await indexer.updateIncremental(newFiles, removedFiles, modifiedFiles);
        if (targets.length > 1) console.log(chalk.green(`  ✅ ${result.removedFiles} fichier(s) supprimé(s), ${result.modifiedFiles} fichier(s) modifié(s), ${result.addedChunks} chunk(s) ajouté(s).`));
        else {
          console.log(chalk.green('\n✅ Mise à jour incrémentale terminée.'));
          console.log(chalk.gray(`  ${result.removedFiles} fichier(s) supprimé(s), ${result.modifiedFiles} fichier(s) modifié(s), ${result.addedChunks} chunk(s) ajouté(s).`));
        }
      }
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('\n❌ Erreur:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('search')
  .description('Rechercher dans la/les codebase(s) indexée(s)')
  .argument('<query>', 'Requête de recherche')
  .option('-c, --config <path>', 'Chemin vers le fichier de configuration')
  .option('-d, --db <path>', 'Index à interroger (optionnel : si absent, recherche dans tous les index sous ~/embed)')
  .option('-r, --root <path>', 'Racine des index pour recherche globale (sans -d)', EMBED_ROOT)
  .option('-l, --limit <n>', 'Nombre maximum de résultats', '10')
  .option('-f, --format <format>', 'Format de sortie (terminal, json, md)', 'terminal')
  .option('-e, --extension <ext>', 'Filtrer par extension (répétable)', [])
  .option('--file-pattern <pattern>', 'Filtrer par pattern de fichier')
  .option('-t, --type <type>', 'Type de recherche (vector, hybrid)', 'vector')
  .option('-w, --weight <n>', 'Poids du nom de fichier en recherche hybride (0-1)', '0.2')
  .option('--candidate-pool <n>', 'Nombre de candidats avant reranking (défaut: config)')
  .option('--rerank-top-k <n>', 'Nombre de candidats rerankés finement (défaut: config)')
  .option('--exact-symbol', 'Prioriser les correspondances exactes de symboles')
  .action(async (query: string, options: CmdOpts) => {
    try {
      const config = await loadConfig(optConfigPath(options.config));
      validateConfig(config);

      const limit = parseInt(String(options.limit), 10);
      const extOpt = options.extension;
      const extensions = Array.isArray(extOpt)
        ? extOpt.filter((x): x is string => typeof x === 'string')
        : typeof extOpt === 'string'
          ? [extOpt]
          : [];
      const searchOpts = {
        query,
        limit,
        extensions: extensions.length > 0 ? extensions : undefined,
        filePattern: typeof options.filePattern === 'string' ? options.filePattern : undefined,
        type: (options.type === 'hybrid' ? 'hybrid' : 'vector') as 'vector' | 'hybrid',
        fileNameWeight: parseFloat(String(options.weight ?? '0.2')),
        candidatePool: options.candidatePool != null && options.candidatePool !== ''
          ? parseInt(String(options.candidatePool), 10)
          : undefined,
        rerankTopK: options.rerankTopK != null && options.rerankTopK !== ''
          ? parseInt(String(options.rerankTopK), 10)
          : undefined,
        exactSymbol: Boolean(options.exactSymbol),
      };

      let dbPaths: string[];
      if (options.db != null && String(options.db).length > 0) {
        dbPaths = [String(options.db)];
      } else {
        const root = String(options.root ?? EMBED_ROOT).replace(/^~/, homedir());
        dbPaths = [];
        try {
          const db = await lancedb.connect(root);
          const names = await db.tableNames();
          if (names.includes('codebase')) dbPaths.push(root);
        } catch {
          // skip
        }
        try {
          const dirs = await readdir(root, { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory() || d.name.startsWith('.')) continue;
            const subPath = join(root, d.name);
            try {
              const db = await lancedb.connect(subPath);
              const names = await db.tableNames();
              if (names.includes('codebase')) dbPaths.push(subPath);
            } catch {
              // skip
            }
          }
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
        }
        if (dbPaths.length === 0) {
          console.log(chalk.yellow('Aucun index trouvé. Utilisez -d <path> ou indexez avec "codebase-search index <path>".'));
          process.exit(1);
          return;
        }
      }

      const allResults: { chunk: any; score: number }[] = [];
      let formatter: CodebaseSearcher | null = null;
      for (const dbPath of dbPaths) {
        const searcher = new CodebaseSearcher(config, dbPath);
        await searcher.initialize();
        if (!formatter) formatter = searcher;
        const results = await searcher.search({ ...searchOpts, limit: limit * 2 });
        allResults.push(...results);
      }
      allResults.sort((a, b) => a.score - b.score);
      const top = allResults.slice(0, limit);
      const output = formatter!.formatResults(top, String(options.format ?? 'terminal') as 'terminal' | 'json' | 'md');
      console.log(output);

      process.exit(0);
    } catch (error) {
      console.error(chalk.red('\n❌ Erreur:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('stats')
  .description('Afficher les statistiques de l\'index')
  .option('-c, --config <path>', 'Chemin vers le fichier de configuration')
  .option('-d, --db <path>', 'Chemin vers la base de données LanceDB', DEFAULT_DB_PATH)
  .action(async (options: CmdOpts) => {
    try {
      const config = await loadConfig(optConfigPath(options.config));
      const searcher = new CodebaseSearcher(config, String(options.db ?? DEFAULT_DB_PATH));
      await searcher.initialize();
      
      const stats = await searcher.getStats();
      
      console.log(chalk.blue('\n📊 Statistiques de l\'index:'));
      console.log(`  Chunks indexés: ${stats.totalChunks}`);
      console.log(`  Extensions:`);
      Object.entries(stats.extensions)
        .sort((a, b) => b[1] - a[1])
        .forEach(([ext, count]) => {
          console.log(`    ${ext}: ${count}`);
        });
      
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('\n❌ Erreur:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Créer un fichier de configuration par défaut')
  .option('-o, --output <path>', 'Chemin de sortie', 'codebase-search.config.json')
  .action(async (options: CmdOpts) => {
    try {
      await createDefaultConfig(String(options.output ?? 'codebase-search.config.json'));
      console.log(chalk.green(`✅ Configuration créée: ${String(options.output ?? 'codebase-search.config.json')}`));
      console.log(chalk.gray('Vous pouvez maintenant modifier ce fichier selon vos besoins.'));
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('\n❌ Erreur:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('test')
  .description('Tester la configuration et la connexion API')
  .option('-c, --config <path>', 'Chemin vers le fichier de configuration')
  .action(async (options: CmdOpts) => {
    try {
      console.log(chalk.blue('🔍 Test de la configuration...\n'));

      const config = await loadConfig(optConfigPath(options.config));
      const apiKey = process.env.mercury_API_KEY || process.env.OPENAI_API_KEY || config.apiKey;
      if (!apiKey) {
        console.error(chalk.red('❌ Clé API manquante : définir mercury_API_KEY/OPENAI_API_KEY ou apiKey dans la config'));
        process.exit(1);
      }
      console.log(chalk.green('✓ Clé API disponible (env ou config)'));

      console.log(chalk.green(`✓ Configuration chargée (${config.extensions.length} extensions)`));
      
      // Test mercury API
      const testSpinner = ora('Test de l\'API mercury...').start();
      try {
        const response = await fetch('https://mercury.ai/api/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            input: ['test'],
            model: config.embeddingModel
          })
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        testSpinner.succeed('API mercury accessible');
      } catch (e) {
        testSpinner.fail(`API mercury inaccessible: ${e}`);
        process.exit(1);
      }
      
      // Test LanceDB
      const lanceSpinner = ora('Test de LanceDB...').start();
      try {
        const db = await lancedb.connect('./.test-db');
        lanceSpinner.succeed('LanceDB fonctionne');
        // Cleanup
        await mkdir('./.test-db', { recursive: true });
        await writeFile('./.test-db/.gitkeep', '');
      } catch (e) {
        lanceSpinner.fail(`LanceDB erreur: ${e}`);
        process.exit(1);
      }
      
      console.log(chalk.green('\n✅ Tous les tests ont réussi!'));
      process.exit(0);
    } catch (error) {
      console.error(chalk.red('\n❌ Erreur:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Gestion des erreurs non capturées
process.on('unhandledRejection', (error) => {
  console.error(chalk.red('\n❌ Erreur non gérée:'), error);
  process.exit(1);
});

program.parse(process.argv);
