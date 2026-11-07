import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const localHosts: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '10.0.2.2': true,
  '10.0.3.2': true,
  '[::1]': true,
};

export function requireLocalEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid local endpoint');
  }
  const authority = endpoint.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  const host = authority
    ?.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/)?.[1]
    ?.toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !host ||
    !Object.hasOwn(localHosts, host) ||
    url.hostname !== host ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Endpoint must use an approved local host');
  return url;
}

/** Writes a debug-only source overlay and an explicitly applied Gradle script. */
export async function writeAppBinding(
  directory: string,
  endpoint: string,
  apiKey: string,
): Promise<{ gradleScript: string; properties: string }> {
  requireLocalEndpoint(endpoint);
  if (!apiKey || /[\r\n]/.test(apiKey))
    throw new Error('A single-line API key is required');
  directory = resolve(directory);
  const debug = join(directory, 'debug');
  await mkdir(join(debug, 'res', 'xml'), { recursive: true });
  const gradleScript = join(directory, 'binding.gradle');
  const properties = join(directory, 'binding.properties');
  const escapeProperty = (value: string) =>
    value.replace(/\\/g, '\\\\').replace(/([:=#!])/g, '\\$1');
  await writeFile(
    properties,
    `HARNESS_URL=${escapeProperty(endpoint)}\nHARNESS_API_KEY=${escapeProperty(apiKey)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    gradleScript,
    `import groovy.json.JsonOutput\n\ndef harnessDirectory = file(providers.gradleProperty('HARNESS_BINDING_DIR').get())\ndef harnessProperties = new Properties()\nnew File(harnessDirectory, 'binding.properties').withInputStream { harnessProperties.load(it) }\nandroid {\n    buildFeatures { buildConfig = true }\n    buildTypes.getByName('debug') {\n        buildConfigField 'String', 'SUPABASE_URL', JsonOutput.toJson(harnessProperties.getProperty('HARNESS_URL'))\n        buildConfigField 'String', 'SUPABASE_ANON_KEY', JsonOutput.toJson(harnessProperties.getProperty('HARNESS_API_KEY'))\n    }\n    sourceSets.getByName('debug').manifest.srcFile(new File(harnessDirectory, 'debug/AndroidManifest.xml'))\n    sourceSets.getByName('debug').res.srcDir(new File(harnessDirectory, 'debug/res'))\n}\n`,
  );
  await writeFile(
    join(debug, 'AndroidManifest.xml'),
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:networkSecurityConfig="@xml/harness_network_security_config" /></manifest>\n`,
  );
  await writeFile(
    join(debug, 'res', 'xml', 'harness_network_security_config.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<network-security-config>\n  <base-config cleartextTrafficPermitted="false" />\n  <domain-config cleartextTrafficPermitted="true">\n    <domain>localhost</domain>\n    <domain>127.0.0.1</domain>\n    <domain>10.0.2.2</domain>\n    <domain>10.0.3.2</domain>\n    <domain>::1</domain>\n  </domain-config>\n</network-security-config>\n`,
  );
  return { gradleScript, properties };
}

export type GuardChallengeResult =
  | 'local-request-completed'
  | 'guard-rejected'
  | 'other-failure';
export type GuardChallenge = (
  endpoint: string,
) => Promise<GuardChallengeResult>;

/** The callback must exercise the app's actual client transport, not a separate guard test. */
export async function requireGuardIntegration(
  endpoint: string,
  challenge?: GuardChallenge,
): Promise<void> {
  requireLocalEndpoint(endpoint);
  if (!challenge)
    throw new Error('App client guard integration is unavailable');
  if (
    (await challenge(endpoint)) !== 'local-request-completed' ||
    (await challenge('https://example.invalid')) !== 'guard-rejected'
  )
    throw new Error('App client guard integration could not be established');
}

export interface DexScan {
  dexFiles: string[];
  localOrigins: string[];
  nonLocalOrigins: string[];
  limitation: string;
}

/** Scan ZIP dex entries as a diagnostic only; a clean result is not a safety guarantee. */
export async function scanApkDex(apkPath: string): Promise<DexScan> {
  const zip = await readFile(apkPath);
  let end = zip.length - 22;
  const minimum = Math.max(0, zip.length - 65557);
  while (
    end >= minimum &&
    (zip.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + zip.readUInt16LE(end + 20) !== zip.length)
  )
    end--;
  if (end < minimum) throw new Error('Invalid APK ZIP directory');
  const count = zip.readUInt16LE(end + 10);
  const offset = zip.readUInt32LE(end + 16);
  if (
    count === 0xffff ||
    offset === 0xffffffff ||
    zip.readUInt16LE(end + 4) !== 0 ||
    zip.readUInt16LE(end + 6) !== 0
  )
    throw new Error('Unsupported APK ZIP directory');
  const dexFiles: string[] = [];
  const localOrigins = new Set<string>();
  const origins = new Set<string>();
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('Invalid APK ZIP entry');
    const method = zip.readUInt16LE(cursor + 10);
    const size = zip.readUInt32LE(cursor + 20);
    const uncompressed = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > zip.length) throw new Error('Invalid APK ZIP entry');
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor = next;
    if (!/^classes(?:[2-9]\d*|1\d+)?.dex$/.test(name)) continue;
    if (
      localOffset + 30 > zip.length ||
      zip.readUInt32LE(localOffset) !== 0x04034b50 ||
      size === 0xffffffff ||
      uncompressed > 256 * 1024 * 1024
    )
      throw new Error('Unsupported APK dex entry');
    const start =
      localOffset +
      30 +
      zip.readUInt16LE(localOffset + 26) +
      zip.readUInt16LE(localOffset + 28);
    if (start + size > zip.length || ![0, 8].includes(method))
      throw new Error('Invalid APK dex entry');
    const data =
      method === 0
        ? zip.subarray(start, start + size)
        : inflateRawSync(zip.subarray(start, start + size), {
            maxOutputLength: 256 * 1024 * 1024,
          });
    if (
      data.length !== uncompressed ||
      data.subarray(0, 4).toString('ascii') !== 'dex\n'
    )
      throw new Error('Invalid APK dex content');
    dexFiles.push(name);
    for (const match of data
      .toString('latin1')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: DEX strings are NUL terminated.
      .matchAll(/https?:\/\/[^\s\x00-\x20"'<>\\]+/gi)) {
      try {
        const url = new URL(match[0]);
        if (Object.hasOwn(localHosts, url.hostname))
          localOrigins.add(url.origin);
        else origins.add(url.origin);
      } catch {
        /* Not a parseable URL candidate. */
      }
    }
  }
  if (!dexFiles.length) throw new Error('APK contains no dex files');
  return {
    dexFiles,
    localOrigins: [...localOrigins].sort(),
    nonLocalOrigins: [...origins].sort(),
    limitation:
      'Diagnostic only: obfuscation, R8, and dynamically constructed strings can hide endpoints; this does not prove safety.',
  };
}
