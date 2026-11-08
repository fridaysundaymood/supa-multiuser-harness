import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [destination, tag] = process.argv.slice(2);
if (!destination || !tag?.startsWith('v')) {
  throw new Error(
    'Usage: node scripts/prepare-publish.mjs <destination> <version tag>',
  );
}
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (`v${manifest.version}` !== tag)
  throw new Error('Version does not match tag');
for (const section of [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    if (!name.startsWith('@budaknyenyel/') || !spec.startsWith('file:'))
      continue;
    const dependency = JSON.parse(
      await readFile(resolve(root, spec.slice(5), 'package.json'), 'utf8'),
    );
    if (dependency.name !== name || dependency.private || !dependency.version) {
      throw new Error(`Invalid publish dependency ${name}`);
    }
    manifest[section][name] = `^${dependency.version}`;
  }
}
const target = resolve(destination);
await mkdir(target, { recursive: true });
for (const file of manifest.files) {
  await cp(join(root, file), join(target, file), { recursive: true });
}
await writeFile(
  join(target, 'package.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
