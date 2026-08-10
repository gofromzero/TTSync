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

function filesUnder(relativeDirectory, predicate = () => true) {
  const absoluteDirectory = join(repositoryRoot, relativeDirectory);
  if (!existsSync(absoluteDirectory)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const entryPath = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(relative(repositoryRoot, entryPath), predicate));
    } else if (entry.isFile() && predicate(entryPath)) {
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

function goImportPaths(source) {
  const importPaths = [];
  for (const groupedImport of source.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
    for (const importedPath of groupedImport[1].matchAll(/(?:^|\n)\s*(?:[A-Za-z_]\w*\s+)?"([^"]+)"/g)) {
      importPaths.push(importedPath[1]);
    }
  }
  for (const singleImport of source.matchAll(/\bimport\s+"([^"]+)"/g)) {
    importPaths.push(singleImport[1]);
  }
  return importPaths;
}

function chiRouteRegistrations(source) {
  return [...source.matchAll(/\b[A-Za-z_]\w*\s*\.\s*(Get|Post|Put|Patch|Delete|Handle|HandleFunc|Method|Mount)\s*\(\s*"([^"]*)"/g)]
    .map((match) => ({ method: match[1], path: match[2] }));
}

function configFieldNames(source) {
  const configDefinition = source.match(/\btype\s+Config\s+struct\s*\{([\s\S]*?)\n\}/);
  assert.ok(configDefinition, 'HTTP adapter 必须定义 Config 允许协作者');
  return [...configDefinition[1].matchAll(/^\s*([A-Z]\w*)\s+/gm)].map((match) => match[1]);
}

function moduleImportPaths(source) {
  return [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
}

test('B-01 Compose 与 Caddy 只暴露三容器 HTTPS 运行面', () => {
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
});

test('B-01 提供 Go、sqlc、四领域与前端的最小工件', () => {
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
});

test('Chi adapter 仅拥有 health 与 SPA 映射允许面', () => {
  const routerSource = readFileSync(requireFile('internal/httpapi/router.go'), 'utf8');
  assert.match(routerSource, /chi\.NewRouter\(\)/, 'HTTP adapter 必须由 Chi router 承担解析和结果映射');
  assert.match(routerSource, /func\s+New\s*\(\s*config\s+Config\s*\)\s+http\.Handler/, 'HTTP adapter 必须经 Config 注入');
  assert.deepEqual(configFieldNames(routerSource).sort(), ['Ready', 'Web'], 'HTTP adapter 只允许 readiness 与嵌入网页协作者');

  const allowedHttpapiImports = new Set([
    'context',
    'embed',
    'encoding/json',
    'io/fs',
    'net/http',
    'path',
    'strings',
    'github.com/go-chi/chi/v5',
  ]);
  const forbiddenCollaboratorCalls = /\.\s*(?:WithTx|Transaction|Begin(?:Tx)?|Commit|Rollback|Require(?:Role|Permission)|Authorize|Check(?:Role|Permission)|Can[A-Z]\w*)\s*\(/;
  const productionHttpapiFiles = filesUnder('internal/httpapi', (file) => file.endsWith('.go') && !file.endsWith('_test.go'));
  assert.ok(productionHttpapiFiles.length > 0, 'HTTP adapter 必须包含生产 Go 文件');
  for (const goFile of productionHttpapiFiles) {
    const source = readFileSync(goFile, 'utf8');
    const imports = goImportPaths(source);
    assert.deepEqual(
      imports.filter((importPath) => importPath.includes('/internal/')),
      [],
      `internal/httpapi 不得导入 internal/app、领域 Module 或 PostgreSQL adapter：${relative(repositoryRoot, goFile)}`,
    );
    assert.deepEqual(
      imports.filter((importPath) => !allowedHttpapiImports.has(importPath)),
      [],
      `internal/httpapi 只能使用 Chi、标准 HTTP/嵌入资产允许依赖：${relative(repositoryRoot, goFile)}`,
    );
    assert.doesNotMatch(source, forbiddenCollaboratorCalls, `internal/httpapi 不得协调事务或授权协作者：${relative(repositoryRoot, goFile)}`);
  }

  const registrations = chiRouteRegistrations(routerSource);
  const allowedHealthPaths = new Set(['/health/live', '/health/ready']);
  const allowedFallbackPaths = new Set(['/', '/*']);
  assert.ok(registrations.some(({ method, path }) => method === 'Get' && path === '/health/live'), '必须注册 /health/live');
  assert.ok(registrations.some(({ method, path }) => method === 'Get' && path === '/health/ready'), '必须注册 /health/ready');
  for (const registration of registrations) {
    const isHealthRead = registration.method === 'Get' && allowedHealthPaths.has(registration.path);
    const isSpaFallback = ['Get', 'Handle', 'HandleFunc'].includes(registration.method) && allowedFallbackPaths.has(registration.path);
    assert.ok(isHealthRead || isSpaFallback, `B-01 不得注册领域路由或写方法：${registration.method} ${registration.path}`);
  }
  assert.ok(
    registrations.some(({ path }) => allowedFallbackPaths.has(path)) || /\.\s*NotFound\s*\(/.test(routerSource),
    'B-01 必须提供 SPA fallback',
  );
});

test('客户端仅包含无 I/O、无领域命令的三角色空壳', () => {
  const appSource = readFileSync(requireFile('clients/web/src/App.vue'), 'utf8');
  const sourceFiles = filesUnder('clients/web/src').map((file) => relative(join(repositoryRoot, 'clients/web/src'), file)).sort();
  assert.deepEqual(sourceFiles, ['App.vue', 'main.ts', 'style.css'], 'B-01 客户端只允许空壳源文件');
  assert.match(appSource, /TTSync/, 'B-01 网页必须提供产品标题');
  for (const roleView of ['主持人视图', '参与者视图', '观众视图']) {
    assert.match(appSource, new RegExp(roleView), `B-01 网页必须提供 ${roleView} 空壳`);
  }

  const forbiddenClientSeams = /\b(?:fetch|axios|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|document\.cookie|createStore|useStore|dispatch|commit|emit|v-model)\b/;
  const forbiddenInternalImport = /(?:from\s+['"][^'"]*internal\/|require\(['"][^'"]*internal\/)/;
  const allowedClientImports = new Set(['vue', './App.vue', './style.css']);
  for (const clientFile of filesUnder('clients/web/src')) {
    const source = readFileSync(clientFile, 'utf8');
    assert.deepEqual(
      moduleImportPaths(source).filter((importPath) => !allowedClientImports.has(importPath)),
      [],
      `B-01 客户端只允许 Vue 与本地空壳资源依赖：${relative(repositoryRoot, clientFile)}`,
    );
    assert.doesNotMatch(source, forbiddenClientSeams, `B-01 客户端不得拥有网络、领域命令或状态写 seam：${relative(repositoryRoot, clientFile)}`);
    assert.doesNotMatch(source, forbiddenInternalImport, `客户端不得直接依赖 Go 领域代码：${relative(repositoryRoot, clientFile)}`);
  }
  assert.doesNotMatch(
    appSource,
    /\b(?:function|async|await|computed|watch|watchEffect|defineEmits|defineProps)\b|=>/,
    'B-01 App.vue 只允许本地展示状态，不能容纳领域逻辑',
  );
});

test('PostgreSQL 是真实 integration adapter，网页构建产物由 Go embed', () => {
  const postgresPoolSource = readFileSync(requireFile('internal/platform/postgres/pool.go'), 'utf8');
  const postgresIntegrationSource = readFileSync(requireFile('internal/platform/postgres/pool_integration_test.go'), 'utf8');
  assert.match(postgresPoolSource, /github\.com\/jackc\/pgx\/v5\/pgxpool/, 'PostgreSQL adapter 必须使用 pgxpool');
  assert.match(postgresIntegrationSource, /^\/\/go:build integration/m, '数据库验收必须是 integration test');
  assert.match(postgresIntegrationSource, /TTSYNC_TEST_DATABASE_URL/, '数据库 integration test 必须使用真实 DSN');
  assert.match(postgresIntegrationSource, /\bOpen\(/, '数据库 integration test 必须打开真实 PostgreSQL adapter');
  assert.match(postgresIntegrationSource, /\bHealth\(/, '数据库 integration test 必须验证真实 PostgreSQL readiness');

  const webEmbedSource = readFileSync(requireFile('internal/httpapi/web.go'), 'utf8');
  assert.match(webEmbedSource, /\/\/go:embed\s+web\/dist\/\*/, '网页构建产物必须通过 go:embed 进入二进制');
});

test('仓库不保存真实秘密', () => {
  const realSecret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/;
  for (const repositoryFile of repositoryFilesUnder('.', new Set(['.git', 'node_modules', '.superpowers']))) {
    const repositoryPath = relative(repositoryRoot, repositoryFile);
    assert.notEqual(basename(repositoryFile), '.env', '仓库不得保存真实 .env 文件');
    assert.doesNotMatch(readFileSync(repositoryFile, 'utf8'), realSecret, `仓库不得保存真实秘密：${repositoryPath}`);
  }
});
