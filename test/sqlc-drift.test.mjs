import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function compare(expected, actual) {
  return spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    'scripts/assert-generated-tree.ps1',
    '-ExpectedDirectory', expected,
    '-ActualDirectory', actual,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
}

test('sqlc drift comparison checks the complete relative file set and bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ttsync-sqlc-drift-'));
  const expected = join(root, 'expected');
  const actual = join(root, 'actual');
  mkdirSync(expected);
  mkdirSync(actual);
  try {
    writeFileSync(join(expected, 'db.go'), 'same\n');
    writeFileSync(join(actual, 'db.go'), 'same\n');
    let result = compare(expected, actual);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);

    writeFileSync(join(expected, 'stale.go'), 'stale\n');
    result = compare(expected, actual);
    assert.notEqual(result.status, 0, 'committed stale generated file must fail');
    rmSync(join(expected, 'stale.go'));

    writeFileSync(join(actual, 'untracked.go'), 'new\n');
    result = compare(expected, actual);
    assert.notEqual(result.status, 0, 'new untracked generated file must fail');
    rmSync(join(actual, 'untracked.go'));

    writeFileSync(join(actual, 'db.go'), 'drift\n');
    result = compare(expected, actual);
    assert.notEqual(result.status, 0, 'generated content drift must fail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
