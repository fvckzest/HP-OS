import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash } from './evidence.mjs';
import { documentedRoutes, routes } from './catalog.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const docs = await Promise.all(['docs/api/api.md', 'docs/api/api-ref.md'].map(f => readFile(root + f, 'utf8')));
const expected = documentedRoutes(...docs);
const actual = routes.map(r => r.route).sort();
if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('The route catalogue differs from the current API documents. Update catalog.mjs before building.');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const workingTree = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
const sourceFiles = async directory => (await readdir(root + directory, { recursive: true }))
  .filter(file => /\.(?:ts|sql)$/.test(file))
  .map(file => directory + '/' + file)
  .sort();
const implementationFiles = [
  'src/app/v1/[...path]/route.ts',
  ...await sourceFiles('src/server'),
  ...await sourceFiles('supabase/migrations'),
];
const implementation = await Promise.all(implementationFiles.map(async file => [file, await readFile(root + file, 'utf8')]));
const snapshot = {
  revision, workingTree, capturedAt: new Date().toISOString(),
  contractHash: hash(docs),
  implementationFiles,
  implementationHash: hash(implementation),
  documentedRoutes: expected,
};
await writeFile(new URL('./source-snapshot.json', import.meta.url), JSON.stringify(snapshot, null, 2) + '\n');
console.log('Captured HP-OS ' + revision.slice(0, 12) + ', hashed ' + implementationFiles.length + ' source/migration files, and verified all ' + expected.length + ' documented route mappings. No API requests or workflows were run.');
