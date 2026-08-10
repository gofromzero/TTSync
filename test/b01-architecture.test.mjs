import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
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

function repositoryFilesUnder(relativeDirectory = '.', ignoredDirectoryNames = new Set()) {
  const absoluteDirectory = join(repositoryRoot, relativeDirectory);
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    const entryPath = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...repositoryFilesUnder(relative(repositoryRoot, entryPath), ignoredDirectoryNames));
    } else if (entry.isFile()) {
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
  const caddySource = readFileSync(requireFile('deployments/Caddyfile'), 'utf8');
  assert.match(caddySource, /tls\s+internal/, 'Caddy 必须是唯一的本地 HTTPS 入口');
  assert.match(caddySource, /reverse_proxy\s+app:8080/, 'Caddy 只能反向代理应用服务');

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

  const forbiddenHttpapiRules = /\b(administrator|host|claim|capacity|permission|authorize|authorization|transaction|begin|commit|rollback)\b/i;
  const forbiddenHttpapiDependencies = /(?:internal\/(?:identity|team|activity|reporting)|database\/sql|github\.com\/jackc\/pgx)/;
  for (const goFile of goFilesUnder('internal/httpapi')) {
    const source = readFileSync(goFile, 'utf8');
    assert.equal(
      forbiddenHttpapiRules.test(source),
      false,
      `internal/httpapi 不得包含权限、事务或领域分支：${relative(repositoryRoot, goFile)}`,
    );
    assert.equal(
      forbiddenHttpapiDependencies.test(source),
      false,
      `internal/httpapi 不得直接依赖领域 Module 或数据库 adapter：${relative(repositoryRoot, goFile)}`,
    );
  }

  const routerSource = readFileSync(requireFile('internal/httpapi/router.go'), 'utf8');
  assert.match(routerSource, /chi\.NewRouter\(\)/, 'HTTP adapter 必须由 Chi router 承担解析和结果映射');
  assert.match(routerSource, /\/health\/live/, 'B-01 必须提供存活健康检查');
  assert.match(routerSource, /\/health\/ready/, 'B-01 必须提供就绪健康检查');
  assert.doesNotMatch(routerSource, /\.(?:Post|Put|Patch|Delete)\s*\(/, 'B-01 不得提前注册领域写命令');

  const appSource = readFileSync(requireFile('clients/web/src/App.vue'), 'utf8');
  assert.match(appSource, /TTSync/, 'B-01 网页必须提供健康页标题');
  for (const roleView of ['主持人视图', '参与者视图', '观众视图']) {
    assert.match(appSource, new RegExp(roleView), `B-01 网页必须提供 ${roleView} 空壳`);
  }

  const forbiddenClientRules = /\b(administrator|claim|capacity|permission|authorize|authorization|transaction)\b/i;
  const forbiddenClientTransport = /\b(fetch|axios|XMLHttpRequest|WebSocket|EventSource)\b/;
  const forbiddenClientDependencies = /(?:from\s+['"][^'"]*internal\/|require\(['"][^'"]*internal\/)/;
  for (const clientFile of repositoryFilesUnder('clients/web/src')) {
    const source = readFileSync(clientFile, 'utf8');
    assert.equal(forbiddenClientRules.test(source), false, `B-01 客户端不得复制领域规则：${relative(repositoryRoot, clientFile)}`);
    assert.equal(forbiddenClientTransport.test(source), false, `B-01 客户端只能提供空角色壳：${relative(repositoryRoot, clientFile)}`);
    assert.equal(forbiddenClientDependencies.test(source), false, `客户端不得直接依赖 Go 领域代码：${relative(repositoryRoot, clientFile)}`);
  }

  const postgresPoolSource = readFileSync(requireFile('internal/platform/postgres/pool.go'), 'utf8');
  const postgresIntegrationSource = readFileSync(requireFile('internal/platform/postgres/pool_integration_test.go'), 'utf8');
  assert.match(postgresPoolSource, /github\.com\/jackc\/pgx\/v5\/pgxpool/, 'PostgreSQL adapter 必须使用 pgxpool');
  assert.match(postgresIntegrationSource, /^\/\/go:build integration/m, '数据库验收必须是 integration test');
  assert.match(postgresIntegrationSource, /TTSYNC_TEST_DATABASE_URL/, '数据库 integration test 必须使用真实 DSN');
  assert.match(postgresIntegrationSource, /\bOpen\(/, '数据库 integration test 必须打开真实 PostgreSQL adapter');
  assert.match(postgresIntegrationSource, /\bHealth\(/, '数据库 integration test 必须验证真实 PostgreSQL readiness');

  const webEmbedSource = readFileSync(requireFile('internal/httpapi/web.go'), 'utf8');
  assert.match(webEmbedSource, /\/\/go:embed\s+web\/dist\/\*/, '网页构建产物必须通过 go:embed 进入二进制');

  const realSecret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/;
  for (const repositoryFile of repositoryFilesUnder('.', new Set(['.git', 'node_modules', '.superpowers']))) {
    const repositoryPath = relative(repositoryRoot, repositoryFile);
    assert.notEqual(basename(repositoryFile), '.env', '仓库不得保存真实 .env 文件');
    assert.equal(
      realSecret.test(readFileSync(repositoryFile, 'utf8')),
      false,
      `仓库不得保存真实秘密：${repositoryPath}`,
    );
  }
});
