import { CodeChunk, Config } from './types.js';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { basename } from 'path';

// Tree-sitter sera chargé dynamiquement si disponible
let TreeSitter: any = null;
let parsers: Map<string, any> = new Map();

export async function initTreeSitter(): Promise<boolean> {
  try {
    const { default: TS } = await import('tree-sitter');
    TreeSitter = TS;
    return true;
  } catch {
    return false;
  }
}

async function getParser(extension: string): Promise<any | null> {
  if (!TreeSitter) return null;
  
  if (parsers.has(extension)) {
    return parsers.get(extension);
  }
  
  try {
    let langModule: any;
    switch (extension) {
      case '.ts':
      case '.tsx':
        langModule = await import('tree-sitter-typescript');
        const tsLang = extension === '.tsx' ? langModule.tsx : langModule.typescript;
        const parser = new TreeSitter();
        parser.setLanguage(tsLang || langModule.default?.tsx || langModule.default?.typescript);
        parsers.set(extension, parser);
        return parser;
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
        langModule = await import('tree-sitter-javascript');
        const jsParser = new TreeSitter();
        jsParser.setLanguage(langModule.default || langModule.javascript);
        parsers.set(extension, jsParser);
        return jsParser;
      case '.py':
      case '.pyx':
      case '.pyi':
        langModule = await import('tree-sitter-python');
        const pyParser = new TreeSitter();
        pyParser.setLanguage(langModule.default || langModule.python);
        parsers.set(extension, pyParser);
        return pyParser;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export async function chunkFile(
  filePath: string,
  config: Config
): Promise<CodeChunk[]> {
  const content = await readFile(filePath, 'utf-8');
  const extension = filePath.substring(filePath.lastIndexOf('.'));
  const fileName = basename(filePath);
  
  // Si Tree-sitter est activé et disponible, essayer le parsing structurel
  if (config.useTreeSitter && TreeSitter) {
    const structuralChunks = await chunkWithTreeSitter(
      filePath, content, extension, config
    );
    if (structuralChunks.length > 0) {
      return structuralChunks;
    }
  }
  
  // Fallback: sliding window
  return chunkWithSlidingWindow(filePath, content, extension, config);
}

async function chunkWithTreeSitter(
  filePath: string,
  content: string,
  extension: string,
  config: Config
): Promise<CodeChunk[]> {
  const parser = await getParser(extension);
  if (!parser) return [];
  
  try {
    const tree = parser.parse(content);
    const chunks: CodeChunk[] = [];
    const fileName = basename(filePath);
    
    // Requêtes pour trouver les fonctions, classes, interfaces, etc.
    const queryPatterns = [
      '(function_declaration) @func',
      '(method_definition) @method',
      '(class_declaration) @class',
      '(interface_declaration) @interface',
      '(type_alias_declaration) @type',
      '(export_statement) @export',
      '(arrow_function) @arrow',
      '(generator_function) @generator'
    ];
    
    const query = new TreeSitter.Query(
      parser.language,
      queryPatterns.join('\n')
    );
    
    const captures = query.captures(tree.rootNode);
    
    for (const { node, name } of captures) {
      const startLine = node.startPosition.row;
      const endLine = node.endPosition.row;
      const nodeContent = content.slice(node.startIndex, node.endIndex);
      
      // Extraire le nom de l'entité si possible
      let entityName: string | undefined;
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        entityName = content.slice(nameNode.startIndex, nameNode.endIndex);
      }
      
      // Découper si trop grand
      if (nodeContent.length > config.chunkSize) {
        const subChunks = splitLargeChunk(
          filePath, fileName, extension, nodeContent,
          startLine, config, name, entityName
        );
        chunks.push(...subChunks);
      } else {
        const chunkId = createHash('md5')
          .update(`${filePath}:${startLine}:${endLine}`)
          .digest('hex');
        
        chunks.push({
          id: chunkId,
          filePath,
          fileName,
          extension,
          content: nodeContent,
          startLine: startLine + 1,
          endLine: endLine + 1,
          type: name,
          name: entityName
        });
      }
    }
    
    // Deduplicate chunks that cover the same line range (e.g. export_statement + function_declaration overlap).
    // Keep the most specific type (non-'export') when ranges collide.
    const seen = new Map<string, CodeChunk>();
    for (const chunk of chunks) {
      const rangeKey = `${chunk.startLine}:${chunk.endLine}`;
      const existing = seen.get(rangeKey);
      if (!existing) {
        seen.set(rangeKey, chunk);
      } else if (existing.type === 'export' && chunk.type !== 'export') {
        // Prefer the more specific type over the generic 'export' wrapper
        seen.set(rangeKey, chunk);
      }
    }

    return Array.from(seen.values());
  } catch (error) {
    return [];
  }
}

function chunkWithSlidingWindow(
  filePath: string,
  content: string,
  extension: string,
  config: Config
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const fileName = basename(filePath);
  const lines = content.split('\n');
  
  let currentChunk = '';
  let currentStartLine = 0;
  let currentLine = 0;
  
  for (const line of lines) {
    // Si ajouter cette ligne dépasse la taille du chunk
    if (currentChunk.length + line.length + 1 > config.chunkSize && currentChunk.length > 0) {
      const chunkId = createHash('md5')
        .update(`${filePath}:${currentStartLine}:${currentLine}`)
        .digest('hex');
      
      chunks.push({
        id: chunkId,
        filePath,
        fileName,
        extension,
        content: currentChunk.trim(),
        startLine: currentStartLine + 1,
        endLine: currentLine
      });
      
      // Chevauchement: garder les dernières lignes
      const overlapLines = currentChunk.split('\n').slice(-3);
      currentChunk = overlapLines.join('\n') + '\n' + line + '\n';
      currentStartLine = currentLine - overlapLines.length + 1;
    } else {
      currentChunk += line + '\n';
    }
    currentLine++;
  }
  
  // Dernier chunk
  if (currentChunk.trim().length > 0) {
    const chunkId = createHash('md5')
      .update(`${filePath}:${currentStartLine}:${currentLine}`)
      .digest('hex');
    
    chunks.push({
      id: chunkId,
      filePath,
      fileName,
      extension,
      content: currentChunk.trim(),
      startLine: currentStartLine + 1,
      endLine: currentLine
    });
  }
  
  return chunks;
}

function splitLargeChunk(
  filePath: string,
  fileName: string,
  extension: string,
  content: string,
  startLine: number,
  config: Config,
  type?: string,
  name?: string
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const lines = content.split('\n');
  
  let currentChunk = '';
  let currentStartLine = startLine;
  let currentLine = startLine;
  let chunkIndex = 0;
  let lastLogicalBreak = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const logicalBreak =
      trimmed === '' ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('/*') ||
      trimmed === '}' ||
      trimmed === '};';

    if (logicalBreak) {
      lastLogicalBreak = i;
    }

    if (currentChunk.length + line.length + 1 > config.chunkSize && currentChunk.length > 0) {
      if (lastLogicalBreak >= 0 && lastLogicalBreak > i - 20) {
        const breakPos = currentChunk.lastIndexOf('\n');
        if (breakPos > 0) {
          currentChunk = currentChunk.slice(0, breakPos);
        }
      }
      const chunkId = createHash('md5')
        .update(`${filePath}:${currentStartLine}:${currentLine}:${chunkIndex}`)
        .digest('hex');
      
      chunks.push({
        id: chunkId,
        filePath,
        fileName,
        extension,
        content: currentChunk.trim(),
        startLine: currentStartLine + 1,
        endLine: currentLine,
        type: chunkIndex === 0 ? type : `${type}_continued`,
        name: chunkIndex === 0 ? name : `${name}_part${chunkIndex + 1}`
      });
      
      chunkIndex++;
      currentChunk = line + '\n';
      currentStartLine = currentLine + 1;
      lastLogicalBreak = -1;
    } else {
      currentChunk += line + '\n';
    }
    currentLine++;
  }
  
  if (currentChunk.trim().length > 0) {
    const chunkId = createHash('md5')
      .update(`${filePath}:${currentStartLine}:${currentLine}:${chunkIndex}`)
      .digest('hex');
    
    chunks.push({
      id: chunkId,
      filePath,
      fileName,
      extension,
      content: currentChunk.trim(),
      startLine: currentStartLine + 1,
      endLine: currentLine,
      type: chunkIndex === 0 ? type : `${type}_continued`,
      name: chunkIndex === 0 ? name : `${name}_part${chunkIndex + 1}`
    });
  }
  
  return chunks;
}
