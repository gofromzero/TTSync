import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const goAstHelper = String.raw`package main

import (
  "encoding/json"
  "go/ast"
  "go/parser"
  "go/token"
  "os"
  "strconv"
)

type Import struct { Name string; Path string }
type Argument struct { Kind string; Value string }
type Call struct { Receiver string; Method string; Arguments []Argument }
type File struct { Path string; Imports []Import; ConfigFields []string; Calls []Call }

func expressionName(expression ast.Expr) string {
  switch value := expression.(type) {
  case *ast.Ident:
    return value.Name
  case *ast.SelectorExpr:
    return expressionName(value.X) + "." + value.Sel.Name
  case *ast.CallExpr:
    return expressionName(value.Fun) + "()"
  case *ast.ParenExpr:
    return expressionName(value.X)
  default:
    return "<expression>"
  }
}

func argumentValue(expression ast.Expr) Argument {
  if literal, ok := expression.(*ast.BasicLit); ok && literal.Kind == token.STRING {
    value, error := strconv.Unquote(literal.Value)
    if error == nil { return Argument{Kind: "string", Value: value} }
  }
  return Argument{Kind: "expression", Value: expressionName(expression)}
}

func main() {
  files := make([]File, 0, len(os.Args)-1)
  for _, path := range os.Args[1:] {
    if path == "--" { continue }
    parsed, error := parser.ParseFile(token.NewFileSet(), path, nil, 0)
    if error != nil { panic(error) }
    file := File{Path: path, Imports: []Import{}, ConfigFields: []string{}, Calls: []Call{}}
    for _, imported := range parsed.Imports {
      importedPath, _ := strconv.Unquote(imported.Path.Value)
      name := ""
      if imported.Name != nil { name = imported.Name.Name }
      file.Imports = append(file.Imports, Import{Name: name, Path: importedPath})
    }
    for _, declaration := range parsed.Decls {
      general, ok := declaration.(*ast.GenDecl)
      if !ok || general.Tok != token.TYPE { continue }
      for _, specification := range general.Specs {
        typeSpecification, ok := specification.(*ast.TypeSpec)
        if !ok || typeSpecification.Name.Name != "Config" { continue }
        structure, ok := typeSpecification.Type.(*ast.StructType)
        if !ok { continue }
        for _, field := range structure.Fields.List {
          if len(field.Names) == 0 { file.ConfigFields = append(file.ConfigFields, "<embedded>") }
          for _, name := range field.Names { file.ConfigFields = append(file.ConfigFields, name.Name) }
        }
      }
    }
    ast.Inspect(parsed, func(node ast.Node) bool {
      call, ok := node.(*ast.CallExpr)
      if !ok { return true }
      result := Call{Arguments: make([]Argument, 0, len(call.Args))}
      switch function := call.Fun.(type) {
      case *ast.SelectorExpr:
        result.Receiver = expressionName(function.X)
        result.Method = function.Sel.Name
      default:
        result.Method = expressionName(function)
      }
      for _, argument := range call.Args { result.Arguments = append(result.Arguments, argumentValue(argument)) }
      file.Calls = append(file.Calls, result)
      return true
    })
    files = append(files, file)
  }
  json.NewEncoder(os.Stdout).Encode(files)
}`;

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

function inspectGoFiles(goFiles) {
  const helperDirectory = mkdtempSync(join(tmpdir(), 'ttsync-b01-go-ast-'));
  const helperPath = join(helperDirectory, 'inspect.go');
  try {
    writeFileSync(helperPath, goAstHelper);
    return JSON.parse(execFileSync('go', ['run', helperPath, '--', ...goFiles], { encoding: 'utf8', windowsHide: true }));
  } finally {
    rmSync(helperDirectory, { recursive: true, force: true });
  }
}

function assertHttpapiAllowedSurface(inspection) {
  const allowedImports = new Set([
    'context',
    'embed',
    'encoding/json',
    'io/fs',
    'net/http',
    'path',
    'strings',
    'github.com/go-chi/chi/v5',
  ]);
  const configFiles = inspection.filter((file) => file.ConfigFields.length > 0);
  assert.equal(configFiles.length, 1, 'HTTP adapter 必须只定义一个 Config 协作者面');
  assert.deepEqual(configFiles[0].ConfigFields.sort(), ['Ready', 'Web'], 'HTTP adapter 只允许 Ready 与 Web 协作者');

  for (const file of inspection) {
    for (const imported of file.Imports) {
      assert.notEqual(imported.Name, '.', `internal/httpapi 不得使用 dot import：${imported.Path}`);
      assert.ok(!imported.Path.includes('/internal/'), `internal/httpapi 不得导入任意 internal 包：${imported.Path}`);
      assert.ok(allowedImports.has(imported.Path), `internal/httpapi 依赖不在允许面：${imported.Path}`);
    }
  }

  const routeMethods = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Handle', 'HandleFunc', 'Method', 'MethodFunc', 'Mount', 'Route', 'Group', 'Use', 'With', 'NotFound']);
  const registrations = inspection.flatMap((file) => file.Calls).filter((call) => routeMethods.has(call.Method));
  const allowedHealthPaths = new Set(['/health/live', '/health/ready']);
  const allowedFallbackPaths = new Set(['/', '/*']);
  assert.ok(registrations.some((call) => call.Method === 'Get' && call.Arguments[0]?.Kind === 'string' && call.Arguments[0].Value === '/health/live'), '必须注册 /health/live');
  assert.ok(registrations.some((call) => call.Method === 'Get' && call.Arguments[0]?.Kind === 'string' && call.Arguments[0].Value === '/health/ready'), '必须注册 /health/ready');

  for (const call of registrations) {
    const path = call.Arguments[0];
    if (call.Method === 'NotFound') {
      continue;
    }
    assert.equal(path?.Kind, 'string', `路由路径必须是字面量：${call.Receiver}.${call.Method}`);
    const isHealthRead = call.Method === 'Get' && allowedHealthPaths.has(path.Value);
    const isSpaFallback = ['Get', 'Handle', 'HandleFunc'].includes(call.Method) && allowedFallbackPaths.has(path.Value);
    assert.ok(isHealthRead || isSpaFallback, `B-01 不得注册领域路由、写路由或中间件：${call.Receiver}.${call.Method} ${path.Value}`);
  }
  assert.ok(
    registrations.some((call) => call.Method === 'NotFound') || registrations.some((call) => ['/', '/*'].includes(call.Arguments[0]?.Value)),
    'B-01 必须提供 SPA fallback',
  );
}

function assertBrowserSmokeAllowedSurface(source) {
  assert.match(source, /chromium\.launch\(/, '浏览器 smoke 必须实际启动 Chromium');
  assert.match(source, /ignoreHTTPSErrors\s*:\s*true/, '浏览器 smoke 必须接受本地 HTTPS 证书');
  assert.match(source, /page\.on\(\s*['"]request['"]/, '浏览器 smoke 必须收集请求集合');
  assert.match(source, /page\.on\(\s*['"]console['"]/, '浏览器 smoke 必须收集 console errors');
  assert.match(source, /expectedInteractiveControls\s*=\s*\[[\s\S]*?'主持人视图'[\s\S]*?'参与者视图'[\s\S]*?'观众视图'[\s\S]*?\]/, '浏览器 smoke 必须声明三角色交互控件允许集');
  assert.match(source, /assert\.deepEqual\(\s*interactiveControls\s*,\s*expectedInteractiveControls\s*\)/, '浏览器 smoke 必须精确断言交互控件集合');
  assert.match(source, /assert\.deepEqual\(\s*requests\s*,\s*\[\]\s*\)/, '浏览器 smoke 必须断言空请求集合');
  assert.match(source, /assert\.deepEqual\(\s*consoleErrors\s*,\s*\[\]\s*\)/, '浏览器 smoke 必须断言无 console error');
}

test('Go AST validator 拒绝 import、路由和中间件绕过', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'ttsync-b01-go-fixtures-'));
  try {
    const baseline = (additional = '', imported = '') => `package httpapi
${imported}
type Config struct { Ready any; Web any }
func routes(r Router, path string) {
  r.Get("/health/live", nil)
  r.Get("/health/ready", nil)
  r.NotFound(nil)
  ${additional}
}`;
    const fixtures = [
      ['dot import', baseline('', 'import . "net/http"')],
      ['Route', baseline('r.Route("/team", nil)')],
      ['Group', baseline('r.Group(nil)')],
      ['Method', baseline('r.Method("GET", "/team", nil)')],
      ['MethodFunc', baseline('r.MethodFunc("GET", "/team", nil)')],
      ['Mount', baseline('r.Mount("/team", nil)')],
      ['Use', baseline('r.Use(nil)')],
      ['With chain', baseline('r.With(nil).Get("/team", nil)')],
      ['variable path', baseline('r.Get(path, nil)')],
    ];
    const fixturePaths = fixtures.map(([name, source]) => {
      const fixturePath = join(fixtureDirectory, `${name.replaceAll(' ', '-')}.go`);
      writeFileSync(fixturePath, source);
      return fixturePath;
    });
    const inspectionByPath = new Map(inspectGoFiles(fixturePaths).map((inspection) => [inspection.Path, inspection]));
    for (const [index, [name]] of fixtures.entries()) {
      assert.throws(
        () => assertHttpapiAllowedSurface([inspectionByPath.get(fixturePaths[index])]),
        assert.AssertionError,
        `Go AST validator 必须拒绝 ${name}`,
      );
    }
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('浏览器 smoke validator 拒绝不完整的空壳验收', () => {
  const validSmoke = `chromium.launch(); const expectedInteractiveControls = ['主持人视图', '参与者视图', '观众视图']; page.on('request', () => {}); page.on('console', () => {}); assert.deepEqual(interactiveControls, expectedInteractiveControls); assert.deepEqual(requests, []); assert.deepEqual(consoleErrors, []); const context = { ignoreHTTPSErrors: true };`;
  assert.doesNotThrow(() => assertBrowserSmokeAllowedSurface(validSmoke));
  for (const [name, source] of [
    ['缺请求集合', validSmoke.replace("page.on('request', () => {}); ", '')],
    ['缺 console 集合', validSmoke.replace("page.on('console', () => {}); ", '')],
    ['缺精确控件集合', validSmoke.replace('assert.deepEqual(interactiveControls, expectedInteractiveControls); ', '')],
  ]) {
    assert.throws(() => assertBrowserSmokeAllowedSurface(source), assert.AssertionError, `浏览器 smoke validator 必须拒绝 ${name}`);
  }
});

test('B-01 Compose 与 Caddy 只暴露三容器 HTTPS 运行面', () => {
  const composePath = requireFile('deployments/compose.yaml');
  const compose = parse(readFileSync(composePath, 'utf8'));
  assert.deepEqual(Object.keys(compose.services ?? {}).sort(), ['app', 'caddy', 'postgres'], 'Compose service 必须严格为 app,caddy,postgres');
  const caddySource = readFileSync(requireFile('deployments/Caddyfile'), 'utf8');
  assert.match(caddySource, /tls\s+internal/, 'Caddy 必须是唯一的本地 HTTPS 入口');
  assert.match(caddySource, /reverse_proxy\s+app:8080/, 'Caddy 只能反向代理应用服务');
});

test('B-01 提供 Go、sqlc、四领域与前端的最小工件', () => {
  for (const requiredPath of ['go.mod', 'db/sqlc.yaml', 'internal/identity/doc.go', 'internal/team/doc.go', 'internal/activity/doc.go', 'internal/reporting/doc.go', 'clients/web/package.json', 'scripts/smoke-b01.ps1']) {
    requireFile(requiredPath);
  }
});

test('Chi adapter 仅拥有 health 与 SPA 映射允许面', () => {
  const routerPath = requireFile('internal/httpapi/router.go');
  const productionHttpapiFiles = filesUnder('internal/httpapi', (file) => file.endsWith('.go') && !file.endsWith('_test.go'));
  assert.ok(productionHttpapiFiles.includes(routerPath), 'router.go 必须是 HTTP adapter 生产文件');
  assertHttpapiAllowedSurface(inspectGoFiles(productionHttpapiFiles));
});

test('客户端空壳由浏览器 smoke 的交互、请求和 console 允许面验收', () => {
  requireFile('clients/web/src/App.vue');
  const sourceFiles = filesUnder('clients/web/src').map((file) => relative(join(repositoryRoot, 'clients/web/src'), file)).sort();
  assert.deepEqual(sourceFiles, ['App.vue', 'main.ts', 'style.css'], 'B-01 客户端只允许空壳源文件');
  const smokeSource = readFileSync(requireFile('test/b01-browser-smoke.mjs'), 'utf8');
  assertBrowserSmokeAllowedSurface(smokeSource);
});

test('PostgreSQL 是真实 integration adapter，网页构建产物由 Go embed', () => {
  const postgresPoolSource = readFileSync(requireFile('internal/platform/postgres/pool.go'), 'utf8');
  const postgresIntegrationSource = readFileSync(requireFile('internal/platform/postgres/pool_integration_test.go'), 'utf8');
  assert.match(postgresPoolSource, /github\.com\/jackc\/pgx\/v5\/pgxpool/, 'PostgreSQL adapter 必须使用 pgxpool');
  assert.match(postgresIntegrationSource, /^\/\/go:build integration/m, '数据库验收必须是 integration test');
  assert.match(postgresIntegrationSource, /TTSYNC_TEST_DATABASE_URL/, '数据库 integration test 必须使用真实 DSN');
  assert.match(postgresIntegrationSource, /\bOpen\(/, '数据库 integration test 必须打开真实 PostgreSQL adapter');
  assert.match(postgresIntegrationSource, /\bHealth\(/, '数据库 integration test 必须验证真实 PostgreSQL readiness');
  assert.match(readFileSync(requireFile('internal/httpapi/web.go'), 'utf8'), /\/\/go:embed\s+web\/dist\/\*/, '网页构建产物必须通过 go:embed 进入二进制');
});

test('仓库不保存真实秘密', () => {
  const realSecret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/;
  for (const repositoryFile of repositoryFilesUnder('.', new Set(['.git', 'node_modules', '.superpowers']))) {
    const repositoryPath = relative(repositoryRoot, repositoryFile);
    assert.notEqual(basename(repositoryFile), '.env', '仓库不得保存真实 .env 文件');
    assert.doesNotMatch(readFileSync(repositoryFile, 'utf8'), realSecret, `仓库不得保存真实秘密：${repositoryPath}`);
  }
});
