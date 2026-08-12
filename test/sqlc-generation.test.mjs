import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function createTestEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'ttsync-sqlc-entrypoint-'));
  const fakeBin = join(root, 'fake-bin');
  const controlledTemp = join(root, 'temp');
  const goMarker = join(root, 'host-go-invoked');
  mkdirSync(fakeBin);
  mkdirSync(controlledTemp);
  writeFileSync(
    join(fakeBin, 'go.cmd'),
    '@echo off\r\ntype nul > "%TTSYNC_SQLC_GO_MARKER%"\r\nexit /b 91\r\n',
  );
  return { root, fakeBin, controlledTemp, goMarker };
}

function runGeneration(environment, extraArguments = []) {
  const childEnvironment = { ...process.env };
  const hostPathKey = Object.keys(childEnvironment).find((key) => key.toLowerCase() === 'path');
  const hostPath = hostPathKey ? childEnvironment[hostPathKey] : '';
  if (hostPathKey) {
    delete childEnvironment[hostPathKey];
  }
  childEnvironment.Path = `${environment.fakeBin};${hostPath}`;
  Object.assign(childEnvironment, {
    GOTOOLCHAIN: 'local',
    TEMP: environment.controlledTemp,
    TMP: environment.controlledTemp,
    TTSYNC_SQLC_GO_MARKER: environment.goMarker,
  });
  return spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'scripts/generate-sqlc.ps1',
      ...extraArguments,
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: childEnvironment,
      timeout: 300_000,
    },
  );
}

function assertNoSqlcTempDirectory(environment) {
  const leftovers = readdirSync(environment.controlledTemp).filter((name) => name.startsWith('ttsync-sqlc-'));
  assert.deepEqual(leftovers, [], `sqlc temporary directories were not removed: ${leftovers.join(', ')}`);
}

test('sqlc generation is isolated from the host Go toolchain', { timeout: 320_000 }, () => {
  const environment = createTestEnvironment();
  try {
    const generation = runGeneration(environment);
    const output = `${generation.stdout ?? ''}${generation.stderr ?? ''}`;
    assert.equal(existsSync(environment.goMarker), false, `sqlc generation must not invoke host go:\n${output}`);
    assert.equal(generation.status, 0, `sqlc generation failed without host Go:\n${output}`);
    assertNoSqlcTempDirectory(environment);
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test('sqlc generation rejects a tampered release archive and cleans up', () => {
  const environment = createTestEnvironment();
  const tamperedArchive = join(environment.root, 'sqlc_1.31.1_windows_amd64.zip');
  writeFileSync(tamperedArchive, 'tampered release bytes');
  try {
    const generation = runGeneration(environment, ['-SqlcArchivePath', tamperedArchive]);
    const output = `${generation.stdout ?? ''}${generation.stderr ?? ''}`;
    assert.notEqual(generation.status, 0, 'tampered sqlc archive must fail');
    assert.match(output, /checksum mismatch/i, `tampered sqlc archive did not fail closed:\n${output}`);
    assert.equal(existsSync(environment.goMarker), false, `checksum failure must occur before host Go could run:\n${output}`);
    assertNoSqlcTempDirectory(environment);
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test('sqlc generation rejects identity generated-tree drift', () => {
  const generated = join(repositoryRoot, 'internal/identity/sqlc/models.go');
  const original = readFileSync(generated, 'utf8');
  try {
    writeFileSync(generated, `${original}\n// intentional drift\n`);
    const generation = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/generate-sqlc.ps1'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 300_000,
    });
    const output = `${generation.stdout ?? ''}${generation.stderr ?? ''}`;
    assert.notEqual(generation.status, 0, `identity drift was accepted:\n${output}`);
    assert.match(output, /sqlc generated content drifted: models\.go/);
  } finally {
    writeFileSync(generated, original);
  }
});
