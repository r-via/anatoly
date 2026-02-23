import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { glob } from 'node:fs/promises';
import { Parser, Language } from 'web-tree-sitter';
import type { Node as TSNode } from 'web-tree-sitter';
import type { Config } from '../schemas/config.js';
import type { Task, SymbolInfo, SymbolKind } from '../schemas/task.js';
import type { Progress, FileProgress } from '../schemas/progress.js';
import { computeFileHash, toOutputName, atomicWriteJson, readProgress } from '../utils/cache.js';

const esmRequire = createRequire(import.meta.url);

const DECLARATION_KINDS: Record<string, SymbolKind> = {
  function_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'type',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  method_definition: 'method',
};

let parserInstance: Parser | null = null;
let tsLanguage: Language | null = null;
let tsxLanguage: Language | null = null;

async function getParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;
  await Parser.init();
  parserInstance = new Parser();
  return parserInstance;
}

async function getTsLanguage(): Promise<Language> {
  if (tsLanguage) return tsLanguage;
  const wasmPath = esmRequire.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
  tsLanguage = await Language.load(wasmPath);
  return tsLanguage;
}

async function getTsxLanguage(): Promise<Language> {
  if (tsxLanguage) return tsxLanguage;
  const wasmPath = esmRequire.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm');
  tsxLanguage = await Language.load(wasmPath);
  return tsxLanguage;
}

function isHookName(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

/**
 * Extract top-level symbols from a tree-sitter AST.
 */
function extractSymbols(rootNode: TSNode): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  for (const node of rootNode.namedChildren) {
    // Handle export statements: `export function/class/type/...`
    if (node.type === 'export_statement') {
      const declaration = node.namedChildren.find(
        (c: TSNode) => c.type in DECLARATION_KINDS || c.type === 'lexical_declaration',
      );
      if (declaration) {
        extractDeclaration(declaration, true, symbols);
      }
      continue;
    }

    // Handle top-level declarations (non-exported)
    if (node.type in DECLARATION_KINDS) {
      extractDeclaration(node, false, symbols);
    } else if (node.type === 'lexical_declaration') {
      extractDeclaration(node, false, symbols);
    }
  }

  return symbols;
}

function extractDeclaration(
  node: TSNode,
  exported: boolean,
  symbols: SymbolInfo[],
): void {
  if (node.type === 'lexical_declaration') {
    // const/let declarations — extract each declarator
    for (const child of node.namedChildren) {
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        if (!nameNode) continue;
        const name = nameNode.text;

        // Determine kind: hook (useXxx), constant (UPPER_SNAKE), or variable
        let kind: SymbolKind;
        if (isHookName(name)) {
          kind = 'hook';
        } else if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
          kind = 'constant';
        } else {
          // Check if the value is an arrow function or function expression
          const value = child.childForFieldName('value');
          if (value && (value.type === 'arrow_function' || value.type === 'function')) {
            kind = 'function';
          } else {
            kind = 'variable';
          }
        }

        symbols.push({
          name,
          kind,
          exported,
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
        });
      }
    }
    return;
  }

  const kind = DECLARATION_KINDS[node.type];
  if (!kind) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;

  // Override kind for hooks: function named useXxx → hook
  const finalKind: SymbolKind = kind === 'function' && isHookName(name) ? 'hook' : kind;

  symbols.push({
    name,
    kind: finalKind,
    exported,
    line_start: node.startPosition.row + 1,
    line_end: node.endPosition.row + 1,
  });
}

/**
 * Parse a single TypeScript/TSX file and extract symbols.
 */
export async function parseFile(
  filePath: string,
  source: string,
): Promise<SymbolInfo[]> {
  const parser = await getParser();
  const lang = filePath.endsWith('.tsx')
    ? await getTsxLanguage()
    : await getTsLanguage();

  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) return [];
  return extractSymbols(tree.rootNode);
}

/**
 * Collect all TypeScript files matching the config patterns.
 */
export async function collectFiles(
  projectRoot: string,
  config: Config,
): Promise<string[]> {
  const files: string[] = [];

  for (const pattern of config.scan.include) {
    for await (const entry of glob(pattern, {
      cwd: projectRoot,
      exclude: config.scan.exclude,
    })) {
      files.push(entry as string);
    }
  }

  // Deduplicate and sort for deterministic output
  return [...new Set(files)].sort();
}

export interface ScanResult {
  filesScanned: number;
  filesCached: number;
  filesNew: number;
}

/**
 * Scan the project: parse AST, compute hashes, generate .task.json, update progress.json.
 */
export async function scanProject(
  projectRoot: string,
  config: Config,
): Promise<ScanResult> {
  const anatolyDir = resolve(projectRoot, '.anatoly');
  const tasksDir = join(anatolyDir, 'tasks');
  const progressPath = join(anatolyDir, 'cache', 'progress.json');

  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(anatolyDir, 'cache'), { recursive: true });

  // Load existing progress
  const existingProgress = readProgress(progressPath);
  const now = new Date().toISOString();

  const progress: Progress = {
    version: 1,
    started_at: existingProgress?.started_at ?? now,
    files: {},
  };

  const files = await collectFiles(projectRoot, config);
  let filesCached = 0;
  let filesNew = 0;

  for (const relPath of files) {
    const absPath = resolve(projectRoot, relPath);
    const hash = computeFileHash(absPath);

    // Check if file is unchanged (CACHED)
    const existing = existingProgress?.files[relPath];
    if (
      existing &&
      existing.hash === hash &&
      (existing.status === 'DONE' || existing.status === 'CACHED')
    ) {
      progress.files[relPath] = {
        file: relPath,
        hash,
        status: 'CACHED',
        updated_at: now,
      };
      filesCached++;
      continue;
    }

    // Parse and generate task
    const source = readFileSync(absPath, 'utf-8');
    const symbols = await parseFile(relPath, source);

    const task: Task = {
      version: 1,
      file: relPath,
      hash,
      symbols,
      scanned_at: now,
    };

    const taskFileName = `${toOutputName(relPath)}.task.json`;
    atomicWriteJson(join(tasksDir, taskFileName), task);

    progress.files[relPath] = {
      file: relPath,
      hash,
      status: 'PENDING',
      updated_at: now,
    } satisfies FileProgress;

    filesNew++;
  }

  // Write progress atomically
  atomicWriteJson(progressPath, progress);

  return {
    filesScanned: files.length,
    filesCached,
    filesNew,
  };
}
