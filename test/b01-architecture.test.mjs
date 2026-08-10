import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function requireFile(relativePath) {
  const absolutePath = join(repositoryRoot, relativePath);
  assert.ok(existsSync(absolutePath), `B-01 必须存在 ${relativePath}`);
  return absolutePath;
}

function goFilesUnder(relativeDirectory) {
  const absoluteDirectory = join(repositoryRoot, relativeDirectory);
  if (!existsSync(absoluteDirectory)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const entryPath = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...goFilesUnder(relative(repositoryRoot, entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.go')) {
      files.push(entryPath);
    }
  }
  return files;
}

test('B-01 运行面遵守服务、模块与 HTTP 边界合同', () => {
  const composePath = requireFile('deployments/compose.yaml');
  const compose = parse(readFileSync(composePath, 'utf8'));
  assert.deepEqual(
    Object.keys(compose.services ?? {}).sort(),
    ['app', 'caddy', 'postgres'],
    'Compose service 必须严格为 app,caddy,postgres',
  );

  for (const requiredPath of [
    'go.mod',
    'db/sqlc.yaml',
    'internal/identity/doc.go',
    'internal/team/doc.go',
    'internal/activity/doc.go',
    'internal/reporting/doc.go',
    'clients/web/package.json',
    'scripts/smoke-b01.ps1',
  ]) {
    requireFile(requiredPath);
  }

  const forbiddenPermissionBranches = /\b(administrator|host|claim|capacity)\b/i;
  for (const goFile of goFilesUnder('internal/httpapi')) {
    const source = readFileSync(goFile, 'utf8');
    assert.equal(
      forbiddenPermissionBranches.test(source),
      false,
      `internal/httpapi 不得包含权限或领域分支：${relative(repositoryRoot, goFile)}`,
    );
  }
});
