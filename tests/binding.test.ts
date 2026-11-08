import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  requireGuardIntegration,
  requireLocalEndpoint,
  scanApkDex,
  writeAppBinding,
} from '../src/core/binding.js';

function apk(entries: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const compressed = deflateRawSync(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const entry = Buffer.concat([local, filename, compressed]);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(entry);
    central.push(Buffer.concat([directory, filename]));
    offset += entry.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('app binding', () => {
  it('accepts only explicit local hosts', () => {
    for (const value of [
      'http://localhost:54321',
      'http://127.0.0.1',
      'http://[::1]',
    ])
      expect(() => requireLocalEndpoint(value)).not.toThrow();
    for (const value of [
      'http://127.1',
      'https://example.com',
      'http://localhost.example.com',
      'http://localhost@evil.test',
      'file:///tmp/x',
      'http://localhost/#x',
    ])
      expect(() => requireLocalEndpoint(value)).toThrow();
  });
  it('requires explicit opt-in for emulator aliases', () => {
    for (const value of ['http://10.0.2.2', 'http://10.0.3.2']) {
      expect(() => requireLocalEndpoint(value)).toThrow();
      expect(() => requireLocalEndpoint(value, true)).not.toThrow();
    }
    expect(() => requireLocalEndpoint('http://10.0.2.3', true)).toThrow();
  });
  it('writes a path-independent debug-only overlay with private properties', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'binding-'));
    try {
      const result = await writeAppBinding(
        dir,
        'http://127.0.0.1:54321',
        'key:secret',
      );
      const script = await readFile(result.gradleScript, 'utf8');
      expect(script).toContain("buildTypes.getByName('debug')");
      expect(script).toContain('HARNESS_BINDING_DIR');
      expect(script).not.toContain(dir);
      expect(script).not.toContain('key:secret');
      expect(await readFile(result.properties, 'utf8')).toContain(
        'key\\:secret',
      );
      const security = await readFile(
        join(dir, 'debug/res/xml/harness_network_security_config.xml'),
        'utf8',
      );
      expect(security).toContain('cleartextTrafficPermitted="false"');
      expect(security).not.toContain('<domain>10.0.2.2</domain>');
      expect(security).not.toContain('<domain>10.0.3.2</domain>');
      await expect(
        writeAppBinding(dir, 'http://10.0.2.2:54321', 'key'),
      ).rejects.toThrow();
      await writeAppBinding(dir, 'http://10.0.2.2:54321', 'key', true);
      const emulatorSecurity = await readFile(
        join(dir, 'debug/res/xml/harness_network_security_config.xml'),
        'utf8',
      );
      expect(emulatorSecurity).toContain('<domain>10.0.2.2</domain>');
      expect(emulatorSecurity).toContain('<domain>10.0.3.2</domain>');
      await writeAppBinding(dir, 'http://127.0.0.1:54321', 'key');
      expect(
        await readFile(
          join(dir, 'debug/res/xml/harness_network_security_config.xml'),
          'utf8',
        ),
      ).not.toContain('<domain>10.0.2.2</domain>');
      await expect(
        writeAppBinding(dir, 'https://remote.example', 'key'),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('fails closed without a real exercised client challenge', async () => {
    await expect(requireGuardIntegration('http://127.0.0.1')).rejects.toThrow();
    await expect(
      requireGuardIntegration('http://127.0.0.1', async () => 'other-failure'),
    ).rejects.toThrow();
    const calls: string[] = [];
    await requireGuardIntegration('http://127.0.0.1', async (endpoint) => {
      calls.push(endpoint);
      return endpoint.includes('example.invalid')
        ? 'guard-rejected'
        : 'local-request-completed';
    });
    expect(calls).toEqual(['http://127.0.0.1', 'https://example.invalid']);
    const challenge = async (endpoint: string) =>
      endpoint.includes('example.invalid')
        ? ('guard-rejected' as const)
        : ('local-request-completed' as const);
    await expect(
      requireGuardIntegration('http://10.0.2.2', challenge),
    ).rejects.toThrow();
    await expect(
      requireGuardIntegration('http://10.0.2.2', challenge, true),
    ).resolves.toBeUndefined();
    await expect(
      requireGuardIntegration(
        'http://127.0.0.1',
        async () => 'local-request-completed',
      ),
    ).rejects.toThrow();
  });
  it('scans all compressed dex entries without exposing URL secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apk-'));
    try {
      const path = join(dir, 'app.apk');
      await writeFile(
        path,
        apk({
          'classes.dex': Buffer.from('dex\n035\0http://127.0.0.1:54321\0'),
          'classes2.dex': Buffer.from(
            'dex\n035\0https://remote.example/private?secret=token\0',
          ),
        }),
      );
      const result = await scanApkDex(path);
      expect(result.dexFiles).toEqual(['classes.dex', 'classes2.dex']);
      expect(result.localOrigins).toEqual(['http://127.0.0.1:54321']);
      expect(result.nonLocalOrigins).toEqual(['https://remote.example']);
      expect(result.limitation).toContain('does not prove safety');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
