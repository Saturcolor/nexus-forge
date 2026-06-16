#!/usr/bin/env node
/**
 * Lit MASTERMIND/VERSION et met à jour le champ "version" de tous les package.json du workspace.
 * Usage : modifier uniquement VERSION, puis `npm run version:sync`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionPath = path.join(root, 'VERSION');

if (!fs.existsSync(versionPath)) {
  console.error(`Fichier introuvable : ${versionPath}`);
  process.exit(1);
}

const version = fs.readFileSync(versionPath, 'utf-8').trim().split(/\r?\n/)[0]?.trim() ?? '';
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`VERSION invalide (attendu semver du type 1.2.3) : "${version}"`);
  process.exit(1);
}

const files = [
  'package.json',
  'packages/backend/package.json',
  'packages/frontend/package.json',
  'packages/shared/package.json',
  'packages/codebase-search/package.json',
];

for (const rel of files) {
  const p = path.join(root, rel);
  const raw = fs.readFileSync(p, 'utf-8');
  const pkg = JSON.parse(raw);
  pkg.version = version;
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${rel} → ${version}`);
}

console.log(`\nOK — version ${version} synchronisée (${files.length} package.json).`);
