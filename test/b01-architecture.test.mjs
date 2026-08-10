import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import ts from 'typescript';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const goAstHelper = String.raw`package main

import (
  "bytes"
  "encoding/json"
  "fmt"
  "go/ast"
  "go/importer"
  "go/parser"
  "go/printer"
  "go/token"
  "go/types"
  "os"
  "path/filepath"
  "sort"
  "strconv"
  "strings"
)

type Import struct { Name string; Path string }
type Argument struct { Kind string; Value string }
type Field struct { Name string; Type string; Tag string }
type Parameter struct { Name string; Type string }
type Function struct { Name string; Receiver bool; TypeParameters int; Parameters []Parameter; Results []string }
type TopLevel struct { Kind string; Names []string }
type Call struct { File string; Function string; Receiver string; Name string; Package string; ObjectKind string; Arguments []Argument }
type Selector struct { File string; Function string; Receiver string; Name string; Package string; ObjectKind string; DirectCall bool }
type Binding struct { File string; Function string; Target string; Package string; Name string }
type Write struct { File string; Function string; Target string }
type Return struct { File string; Function string; Values []Argument }
type File struct {
  Path string
  Imports []Import
  ConfigFields []Field
  Functions []Function
  TopLevels []TopLevel
  Calls []Call
  Selectors []Selector
  Bindings []Binding
  Writes []Write
  Returns []Return
}
type Package struct { Directory string; TypeErrors []string; Files []File }

const chiPath = "github.com/go-chi/chi/v5"
const chiStub = "package chi\n" +
  "import \"net/http\"\n" +
  "type Router interface {\n" +
  "  http.Handler\n" +
  "  Use(...func(http.Handler) http.Handler)\n" +
  "  With(...func(http.Handler) http.Handler) Router\n" +
  "  Group(func(Router)) Router\n" +
  "  Route(string, func(Router)) Router\n" +
  "  Mount(string, http.Handler)\n" +
  "  Handle(string, http.Handler)\n" +
  "  HandleFunc(string, http.HandlerFunc)\n" +
  "  Method(string, string, http.Handler)\n" +
  "  MethodFunc(string, string, http.HandlerFunc)\n" +
  "  Connect(string, http.HandlerFunc)\n" +
  "  Delete(string, http.HandlerFunc)\n" +
  "  Get(string, http.HandlerFunc)\n" +
  "  Head(string, http.HandlerFunc)\n" +
  "  Options(string, http.HandlerFunc)\n" +
  "  Patch(string, http.HandlerFunc)\n" +
  "  Post(string, http.HandlerFunc)\n" +
  "  Put(string, http.HandlerFunc)\n" +
  "  Trace(string, http.HandlerFunc)\n" +
  "  NotFound(http.HandlerFunc)\n" +
  "  MethodNotAllowed(http.HandlerFunc)\n" +
  "}\n" +
  "func NewRouter() Router { return nil }\n"

type allowedImporter struct { standard types.Importer; chi *types.Package }

func newAllowedImporter() *allowedImporter {
  standard := importer.Default()
  fileSet := token.NewFileSet()
  file, error := parser.ParseFile(fileSet, "chi.go", chiStub, 0)
  if error != nil { panic(error) }
  configuration := types.Config{Importer: standard}
  chi, error := configuration.Check(chiPath, fileSet, []*ast.File{file}, nil)
  if error != nil { panic(error) }
  return &allowedImporter{standard: standard, chi: chi}
}

func (value *allowedImporter) Import(path string) (*types.Package, error) {
  if path == chiPath { return value.chi, nil }
  return value.standard.Import(path)
}

func expressionText(fileSet *token.FileSet, expression ast.Expr) string {
  var buffer bytes.Buffer
  if error := printer.Fprint(&buffer, fileSet, expression); error != nil { return "<expression>" }
  return buffer.String()
}

func argumentValue(fileSet *token.FileSet, expression ast.Expr) Argument {
  if literal, ok := expression.(*ast.BasicLit); ok && literal.Kind == token.STRING {
    value, error := strconv.Unquote(literal.Value)
    if error == nil { return Argument{Kind: "string", Value: value} }
  }
  if identifier, ok := expression.(*ast.Ident); ok {
    return Argument{Kind: "identifier", Value: identifier.Name}
  }
  return Argument{Kind: "expression", Value: expressionText(fileSet, expression)}
}

func objectDetails(object types.Object) (string, string) {
  if object == nil { return "", "unknown" }
  packagePath := ""
  if object.Pkg() != nil { packagePath = object.Pkg().Path() }
  kind := "unknown"
  switch object.(type) {
  case *types.Builtin:
    kind = "builtin"
  case *types.Func:
    kind = "func"
  case *types.TypeName:
    kind = "type"
  case *types.Var:
    kind = "var"
  case *types.Const:
    kind = "const"
  }
  return packagePath, kind
}

func selectorObject(info *types.Info, selector *ast.SelectorExpr) types.Object {
  if selection := info.Selections[selector]; selection != nil { return selection.Obj() }
  return info.Uses[selector.Sel]
}

func callObject(info *types.Info, expression ast.Expr) (types.Object, string) {
  switch value := expression.(type) {
  case *ast.Ident:
    return info.Uses[value], value.Name
  case *ast.SelectorExpr:
    return selectorObject(info, value), value.Sel.Name
  case *ast.ParenExpr:
    return callObject(info, value.X)
  case *ast.IndexExpr:
    return callObject(info, value.X)
  case *ast.IndexListExpr:
    return callObject(info, value.X)
  default:
    return nil, "<expression>"
  }
}

func inspectNode(fileSet *token.FileSet, info *types.Info, filePath string, functionName string, node ast.Node, output *File) {
  directCalls := map[*ast.SelectorExpr]bool{}
  ast.Inspect(node, func(current ast.Node) bool {
    if call, ok := current.(*ast.CallExpr); ok {
      if selector, ok := call.Fun.(*ast.SelectorExpr); ok { directCalls[selector] = true }
    }
    return true
  })

  ast.Inspect(node, func(current ast.Node) bool {
    switch value := current.(type) {
    case *ast.CallExpr:
      object, name := callObject(info, value.Fun)
      receiver := ""
      if selector, ok := value.Fun.(*ast.SelectorExpr); ok { receiver = expressionText(fileSet, selector.X) }
      packagePath, objectKind := objectDetails(object)
      call := Call{File: filePath, Function: functionName, Receiver: receiver, Name: name, Package: packagePath, ObjectKind: objectKind, Arguments: []Argument{}}
      for _, argument := range value.Args { call.Arguments = append(call.Arguments, argumentValue(fileSet, argument)) }
      output.Calls = append(output.Calls, call)
    case *ast.SelectorExpr:
      object := selectorObject(info, value)
      packagePath, objectKind := objectDetails(object)
      output.Selectors = append(output.Selectors, Selector{File: filePath, Function: functionName, Receiver: expressionText(fileSet, value.X), Name: value.Sel.Name, Package: packagePath, ObjectKind: objectKind, DirectCall: directCalls[value]})
    case *ast.AssignStmt:
      for _, left := range value.Lhs {
        output.Writes = append(output.Writes, Write{File: filePath, Function: functionName, Target: expressionText(fileSet, left)})
      }
      for index, right := range value.Rhs {
        call, ok := right.(*ast.CallExpr)
        if !ok || index >= len(value.Lhs) { continue }
        object, name := callObject(info, call.Fun)
        packagePath, _ := objectDetails(object)
        output.Bindings = append(output.Bindings, Binding{File: filePath, Function: functionName, Target: expressionText(fileSet, value.Lhs[index]), Package: packagePath, Name: name})
      }
    case *ast.DeclStmt:
      general, ok := value.Decl.(*ast.GenDecl)
      if !ok { break }
      for _, specification := range general.Specs {
        variable, ok := specification.(*ast.ValueSpec)
        if !ok { continue }
        for index, name := range variable.Names {
          output.Writes = append(output.Writes, Write{File: filePath, Function: functionName, Target: name.Name})
          if index >= len(variable.Values) { continue }
          call, ok := variable.Values[index].(*ast.CallExpr)
          if !ok { continue }
          object, callName := callObject(info, call.Fun)
          packagePath, _ := objectDetails(object)
          output.Bindings = append(output.Bindings, Binding{File: filePath, Function: functionName, Target: name.Name, Package: packagePath, Name: callName})
        }
      }
    case *ast.ReturnStmt:
      result := Return{File: filePath, Function: functionName, Values: []Argument{}}
      for _, expression := range value.Results { result.Values = append(result.Values, argumentValue(fileSet, expression)) }
      output.Returns = append(output.Returns, result)
    }
    return true
  })
}

func inspectPackage(directory string, paths []string) Package {
  fileSet := token.NewFileSet()
  syntaxFiles := []*ast.File{}
  output := Package{Directory: directory, TypeErrors: []string{}, Files: []File{}}
  parsedByPath := map[string]*ast.File{}
  for _, path := range paths {
    parsed, error := parser.ParseFile(fileSet, path, nil, parser.ParseComments)
    if error != nil {
      output.TypeErrors = append(output.TypeErrors, error.Error())
      continue
    }
    parsedByPath[path] = parsed
    syntaxFiles = append(syntaxFiles, parsed)
  }

  info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}, Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}, Selections: map[*ast.SelectorExpr]*types.Selection{}}
  configuration := types.Config{Importer: newAllowedImporter(), Error: func(error error) { output.TypeErrors = append(output.TypeErrors, error.Error()) }}
  if len(syntaxFiles) > 0 {
    _, _ = configuration.Check("ttsync.local/"+syntaxFiles[0].Name.Name, fileSet, syntaxFiles, info)
  }

  for _, path := range paths {
    parsed := parsedByPath[path]
    if parsed == nil { continue }
    file := File{Path: path, Imports: []Import{}, ConfigFields: []Field{}, Functions: []Function{}, TopLevels: []TopLevel{}, Calls: []Call{}, Selectors: []Selector{}, Bindings: []Binding{}, Writes: []Write{}, Returns: []Return{}}
    for _, imported := range parsed.Imports {
      importedPath, _ := strconv.Unquote(imported.Path.Value)
      name := ""
      if imported.Name != nil { name = imported.Name.Name }
      file.Imports = append(file.Imports, Import{Name: name, Path: importedPath})
    }
    for _, declaration := range parsed.Decls {
      switch value := declaration.(type) {
      case *ast.GenDecl:
        if value.Tok == token.IMPORT { continue }
        names := []string{}
        for _, specification := range value.Specs {
          switch typed := specification.(type) {
          case *ast.TypeSpec:
            names = append(names, typed.Name.Name)
            if typed.Name.Name != "Config" { continue }
            structure, ok := typed.Type.(*ast.StructType)
            if !ok { continue }
            for _, configField := range structure.Fields.List {
              fieldType := expressionText(fileSet, configField.Type)
              tag := ""
              if configField.Tag != nil { tag = configField.Tag.Value }
              if len(configField.Names) == 0 { file.ConfigFields = append(file.ConfigFields, Field{Name: "<embedded>", Type: fieldType, Tag: tag}) }
              for _, name := range configField.Names { file.ConfigFields = append(file.ConfigFields, Field{Name: name.Name, Type: fieldType, Tag: tag}) }
            }
          case *ast.ValueSpec:
            for _, name := range typed.Names { names = append(names, name.Name) }
          }
        }
        file.TopLevels = append(file.TopLevels, TopLevel{Kind: strings.ToLower(value.Tok.String()), Names: names})
        inspectNode(fileSet, info, path, "<package>", value, &file)
      case *ast.FuncDecl:
        parameters := []Parameter{}
        if value.Type.Params != nil {
          for _, field := range value.Type.Params.List {
            fieldType := expressionText(fileSet, field.Type)
            if len(field.Names) == 0 { parameters = append(parameters, Parameter{Name: "", Type: fieldType}) }
            for _, name := range field.Names { parameters = append(parameters, Parameter{Name: name.Name, Type: fieldType}) }
          }
        }
        results := []string{}
        if value.Type.Results != nil {
          for _, field := range value.Type.Results.List {
            count := len(field.Names)
            if count == 0 { count = 1 }
            for index := 0; index < count; index++ { results = append(results, expressionText(fileSet, field.Type)) }
          }
        }
        typeParameters := 0
        if value.Type.TypeParams != nil { typeParameters = len(value.Type.TypeParams.List) }
        file.Functions = append(file.Functions, Function{Name: value.Name.Name, Receiver: value.Recv != nil, TypeParameters: typeParameters, Parameters: parameters, Results: results})
        file.TopLevels = append(file.TopLevels, TopLevel{Kind: "func", Names: []string{value.Name.Name}})
        if value.Body != nil { inspectNode(fileSet, info, path, value.Name.Name, value.Body, &file) }
      }
    }
    output.Files = append(output.Files, file)
  }
  sort.Strings(output.TypeErrors)
  return output
}

func main() {
  pathsByDirectory := map[string][]string{}
  directories := []string{}
  for _, path := range os.Args[1:] {
    if path == "--" { continue }
    absolutePath, error := filepath.Abs(path)
    if error != nil { panic(error) }
    directory := filepath.Dir(absolutePath)
    if _, exists := pathsByDirectory[directory]; !exists { directories = append(directories, directory) }
    pathsByDirectory[directory] = append(pathsByDirectory[directory], absolutePath)
  }
  sort.Strings(directories)
  packages := []Package{}
  for _, directory := range directories {
    sort.Strings(pathsByDirectory[directory])
    packages = append(packages, inspectPackage(directory, pathsByDirectory[directory]))
  }
  if error := json.NewEncoder(os.Stdout).Encode(packages); error != nil { panic(fmt.Errorf("encode inspection: %w", error)) }
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

function moduleImportPaths(source) {
  return [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
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

function writeFixture(directory, name, source) {
  const fixtureDirectory = join(directory, name.replaceAll(/[\\/:*?"<>|.]/g, '-'));
  mkdirSync(fixtureDirectory);
  const fixturePath = join(fixtureDirectory, 'router.go');
  writeFileSync(fixturePath, source);
  return fixturePath;
}

function assertHttpapiAllowedSurface(inspection) {
  assert.equal(inspection.length, 1, 'HTTP adapter 必须作为单一 Go package 检查');
  const [inspectedPackage] = inspection;
  assert.deepEqual(inspectedPackage.TypeErrors, [], `HTTP adapter 必须通过 go/types：${inspectedPackage.TypeErrors.join('; ')}`);
  const files = inspectedPackage.Files;
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
  const configFiles = files.filter((file) => file.ConfigFields.length > 0);
  assert.equal(configFiles.length, 1, 'HTTP adapter 必须只定义一个 Config 协作者面');
  assert.deepEqual(
    configFiles[0].ConfigFields,
    [
      { Name: 'Ready', Type: 'func(context.Context) error', Tag: '' },
      { Name: 'Web', Type: 'fs.FS', Tag: '' },
    ],
    'Config 必须精确为 Ready func(context.Context) error 与 Web fs.FS',
  );

  for (const file of files) {
    for (const imported of file.Imports) {
      assert.notEqual(imported.Name, '.', `internal/httpapi 不得使用 dot import：${imported.Path}`);
      assert.ok(imported.Name === '' || (imported.Name === '_' && imported.Path === 'embed'), `internal/httpapi 不得改名或旁路 import：${imported.Name} ${imported.Path}`);
      assert.ok(!imported.Path.includes('/internal/'), `internal/httpapi 不得导入任意 internal 包：${imported.Path}`);
      assert.ok(allowedImports.has(imported.Path), `internal/httpapi 依赖不在允许面：${imported.Path}`);
    }
  }

  const routerFile = files.find((file) => basename(file.Path) === 'router.go');
  assert.ok(routerFile, 'HTTP adapter 必须包含 router.go');
  assert.deepEqual(
    routerFile.TopLevels,
    [
      { Kind: 'type', Names: ['Config'] },
      { Kind: 'func', Names: ['New'] },
    ],
    'router.go 顶层只允许 Config 与 New',
  );
  const newFunctions = routerFile.Functions.filter((fn) => fn.Name === 'New' && !fn.Receiver);
  assert.equal(newFunctions.length, 1, 'router.go 必须只定义一个 New');
  const [newFunction] = newFunctions;
  assert.equal(newFunction.TypeParameters, 0, 'New 不得声明类型参数');
  assert.equal(newFunction.Parameters.length, 1, 'New 必须只接收 Config');
  assert.equal(newFunction.Parameters[0].Type, 'Config', 'New 参数必须是 Config');
  assert.deepEqual(newFunction.Results, ['http.Handler'], 'New 必须精确返回 http.Handler');
  const configName = newFunction.Parameters[0].Name;
  assert.ok(configName, 'New 的 Config 参数必须命名并由函数消费');

  const routerImports = new Map(routerFile.Imports.map((entry) => [entry.Path, entry.Name]));
  for (const requiredImport of ['context', 'io/fs', 'net/http', 'github.com/go-chi/chi/v5']) {
    assert.equal(routerImports.get(requiredImport), '', `router.go 必须直接使用默认 import：${requiredImport}`);
  }

  const routerBindings = routerFile.Bindings.filter((binding) => binding.Function === 'New' && binding.Package === 'github.com/go-chi/chi/v5' && binding.Name === 'NewRouter');
  assert.equal(routerBindings.length, 1, 'New 必须且只能调用一次 chi.NewRouter');
  const routerName = routerBindings[0].Target;
  assert.equal(routerFile.Writes.filter((write) => write.Function === 'New' && write.Target === routerName).length, 1, 'Chi router 变量不得重新赋值');
  assert.ok(
    routerFile.Returns.some((result) => result.Function === 'New' && result.Values.length === 1 && result.Values[0].Kind === 'identifier' && result.Values[0].Value === routerName),
    'New 必须返回 chi.NewRouter 创建的 router',
  );

  const routeMethods = new Set(['Use', 'With', 'Group', 'Route', 'Mount', 'Handle', 'HandleFunc', 'Method', 'MethodFunc', 'Connect', 'Delete', 'Get', 'Head', 'Options', 'Patch', 'Post', 'Put', 'Trace', 'NotFound', 'MethodNotAllowed']);
  const chiSelectors = files.flatMap((file) => file.Selectors).filter((selector) => selector.Package === 'github.com/go-chi/chi/v5' && routeMethods.has(selector.Name));
  for (const selector of chiSelectors) {
    assert.equal(selector.File, routerFile.Path, `Chi 路由注册只能位于 router.go：${selector.Name}`);
    assert.equal(selector.Function, 'New', `Chi 路由注册只能位于 New：${selector.Name}`);
    assert.equal(selector.Receiver, routerName, `Chi 路由必须直接注册到 New 创建的 router：${selector.Receiver}.${selector.Name}`);
    assert.equal(selector.DirectCall, true, `Chi 方法不得作为方法值或经变量调用：${selector.Name}`);
  }

  const registrations = routerFile.Calls.filter((call) => call.Package === 'github.com/go-chi/chi/v5' && routeMethods.has(call.Name));
  const allowedHealthPaths = new Set(['/health/live', '/health/ready']);
  const allowedFallbackPaths = new Set(['/', '/*']);
  assert.ok(registrations.some((call) => call.Name === 'Get' && call.Arguments[0]?.Kind === 'string' && call.Arguments[0].Value === '/health/live'), '必须注册 /health/live');
  assert.ok(registrations.some((call) => call.Name === 'Get' && call.Arguments[0]?.Kind === 'string' && call.Arguments[0].Value === '/health/ready'), '必须注册 /health/ready');

  for (const call of registrations) {
    const path = call.Arguments[0];
    if (call.Name === 'NotFound') {
      continue;
    }
    assert.equal(path?.Kind, 'string', `路由路径必须是字面量：${call.Receiver}.${call.Name}`);
    const isHealthRead = call.Name === 'Get' && allowedHealthPaths.has(path.Value);
    const isSpaFallback = ['Get', 'Handle', 'HandleFunc'].includes(call.Name) && allowedFallbackPaths.has(path.Value);
    assert.ok(isHealthRead || isSpaFallback, `B-01 不得注册领域路由、写路由或中间件：${call.Receiver}.${call.Name} ${path.Value}`);
  }
  assert.ok(
    registrations.some((call) => call.Name === 'NotFound') || registrations.some((call) => ['/', '/*'].includes(call.Arguments[0]?.Value)),
    'B-01 必须提供 SPA fallback',
  );

  assert.ok(routerFile.Calls.some((call) => call.Function === 'New' && call.Receiver === configName && call.Name === 'Ready' && call.ObjectKind === 'var'), 'readiness 必须调用 Config.Ready');
  assert.ok(routerFile.Selectors.some((selector) => selector.Function === 'New' && selector.Receiver === configName && selector.Name === 'Web' && selector.ObjectKind === 'var'), 'SPA 必须消费 Config.Web');

  const allowedStandardCallPackages = new Set(['encoding/json', 'io/fs', 'net/http', 'path', 'strings']);
  for (const call of routerFile.Calls.filter((candidate) => candidate.Function === 'New')) {
    const isChi = call.Package === 'github.com/go-chi/chi/v5';
    const isStandard = allowedStandardCallPackages.has(call.Package);
    const isReady = call.Receiver === configName && call.Name === 'Ready' && call.ObjectKind === 'var';
    const isBuiltin = call.Package === '' && call.ObjectKind === 'builtin' && ['append', 'len', 'make'].includes(call.Name);
    assert.ok(isChi || isStandard || isReady || isBuiltin, `router.go New 调用不在允许面：${call.Receiver ? `${call.Receiver}.` : ''}${call.Name}`);
  }
}

function nodesUnder(root) {
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

function unwrappedExpression(expression) {
  let current = expression;
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function propertyCall(expression, receiverName, methodName) {
  const unwrapped = unwrappedExpression(expression);
  if (!ts.isCallExpression(unwrapped) || !ts.isPropertyAccessExpression(unwrapped.expression)) {
    return undefined;
  }
  const property = unwrapped.expression;
  return ts.isIdentifier(property.expression)
    && property.expression.text === receiverName
    && property.name.text === methodName
    ? unwrapped
    : undefined;
}

function variableBindings(sourceFile) {
  const bindings = new Map();
  for (const node of nodesUnder(sourceFile)) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
  }
  return bindings;
}

function expressionReferencesIdentifier(expression, identifierName) {
  return nodesUnder(expression).some((node) => ts.isIdentifier(node) && node.text === identifierName);
}

function assertBrowserSmokeAllowedSurface(source) {
  const virtualPath = join(tmpdir(), 'ttsync-b01-browser-smoke.mjs');
  const sourceFile = ts.createSourceFile(virtualPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.deepEqual(sourceFile.parseDiagnostics ?? [], [], '浏览器 smoke 必须是有效 JavaScript 语法');

  let chromiumName;
  let assertName;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) {
      continue;
    }
    if (statement.moduleSpecifier.text === 'playwright' && statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      const chromiumImport = statement.importClause.namedBindings.elements.find((element) => (element.propertyName?.text ?? element.name.text) === 'chromium');
      chromiumName = chromiumImport?.name.text;
    }
    if (statement.moduleSpecifier.text === 'node:assert/strict') {
      assertName = statement.importClause.name?.text;
    }
  }
  assert.ok(chromiumName, '浏览器 smoke 必须从 playwright 导入 chromium');
  assert.ok(assertName, '浏览器 smoke 必须导入 node:assert/strict');

  const bindings = variableBindings(sourceFile);
  const bindingForCall = (receiver, method) => [...bindings.entries()].find(([, initializer]) => propertyCall(initializer, receiver, method));
  const browserBinding = bindingForCall(chromiumName, 'launch');
  assert.ok(browserBinding, '浏览器 smoke 必须调用 chromium.launch');
  const [browserName] = browserBinding;
  const contextBinding = bindingForCall(browserName, 'newContext');
  assert.ok(contextBinding, '浏览器 smoke 必须从 browser.newContext 创建 context');
  const [contextName, contextInitializer] = contextBinding;
  const contextCall = propertyCall(contextInitializer, browserName, 'newContext');
  assert.ok(
    contextCall.arguments.some((argument) => ts.isObjectLiteralExpression(argument)
      && argument.properties.some((property) => ts.isPropertyAssignment(property)
        && property.name.getText(sourceFile) === 'ignoreHTTPSErrors'
        && property.initializer.kind === ts.SyntaxKind.TrueKeyword)),
    '浏览器 smoke context 必须设置 ignoreHTTPSErrors: true',
  );
  const pageBinding = bindingForCall(contextName, 'newPage');
  assert.ok(pageBinding, '浏览器 smoke 必须从 context.newPage 创建 page');
  const [pageName] = pageBinding;

  const calls = nodesUnder(sourceFile).filter(ts.isCallExpression);
  const gotoCall = calls.find((call) => propertyCall(call, pageName, 'goto'));
  assert.ok(gotoCall, '浏览器 smoke 必须调用 page.goto');
  const gotoArgument = gotoCall.arguments[0];
  assert.ok(gotoArgument, 'page.goto 必须提供 HTTPS URL');
  const gotoSource = ts.isIdentifier(gotoArgument) ? bindings.get(gotoArgument.text) : gotoArgument;
  assert.ok(gotoSource && nodesUnder(gotoSource).some((node) => ts.isStringLiteralLike(node) && node.text.startsWith('https://')), 'page.goto 必须访问 HTTPS');

  const expectedRolesBinding = [...bindings.entries()].find(([, initializer]) => ts.isArrayLiteralExpression(initializer)
    && initializer.elements.every(ts.isStringLiteralLike)
    && JSON.stringify(initializer.elements.map((element) => element.text)) === JSON.stringify(['主持人视图', '参与者视图', '观众视图']));
  assert.ok(expectedRolesBinding, '浏览器 smoke 必须声明精确的三角色控件集合');
  const [expectedRolesName] = expectedRolesBinding;

  const controlsBinding = [...bindings.entries()].find(([, initializer]) => {
    const outer = unwrappedExpression(initializer);
    if (!ts.isCallExpression(outer) || !ts.isPropertyAccessExpression(outer.expression) || outer.expression.name.text !== 'allTextContents') {
      return false;
    }
    const roleCall = unwrappedExpression(outer.expression.expression);
    return Boolean(propertyCall(roleCall, pageName, 'getByRole'))
      && roleCall.arguments[0] && ts.isStringLiteralLike(roleCall.arguments[0]) && roleCall.arguments[0].text === 'tab';
  });
  assert.ok(controlsBinding, '浏览器 smoke 必须从 page.getByRole(tab) 读取真实 DOM 控件');
  const [controlsName] = controlsBinding;

  const hasDeepEqual = (actualName, expectedPredicate) => calls.some((call) => {
    if (!ts.isPropertyAccessExpression(call.expression)
      || !ts.isIdentifier(call.expression.expression)
      || call.expression.expression.text !== assertName
      || call.expression.name.text !== 'deepEqual'
      || !call.arguments[0]
      || !ts.isIdentifier(call.arguments[0])
      || call.arguments[0].text !== actualName) {
      return false;
    }
    return expectedPredicate(call.arguments[1]);
  });
  assert.ok(hasDeepEqual(controlsName, (expected) => ts.isIdentifier(expected) && expected.text === expectedRolesName), '浏览器 smoke 必须精确断言 DOM role 集合');

  const collectorForEvent = (eventName) => {
    const listener = calls.find((call) => {
      const onCall = propertyCall(call, pageName, 'on');
      return onCall && onCall.arguments[0] && ts.isStringLiteralLike(onCall.arguments[0]) && onCall.arguments[0].text === eventName;
    });
    assert.ok(listener, '浏览器 smoke 必须监听 page ' + eventName);
    const callback = listener.arguments[1];
    assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters.length > 0 && ts.isIdentifier(callback.parameters[0].name), 'page ' + eventName + ' listener 必须接收事件');
    const eventParameter = callback.parameters[0].name.text;
    const pushCall = nodesUnder(callback.body).find((node) => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.name.text === 'push'
      && node.arguments.some((argument) => expressionReferencesIdentifier(argument, eventParameter)));
    assert.ok(pushCall, 'page ' + eventName + ' listener 必须采集真实事件数据');
    const collectorName = pushCall.expression.expression.text;
    const collectorInitializer = bindings.get(collectorName);
    assert.ok(collectorInitializer && ts.isArrayLiteralExpression(collectorInitializer), 'page ' + eventName + ' collector 必须是已定义数组');
    return collectorName;
  };

  const requestsName = collectorForEvent('request');
  const consoleErrorsName = collectorForEvent('console');
  const isEmptyArray = (value) => ts.isArrayLiteralExpression(value) && value.elements.length === 0;
  assert.ok(hasDeepEqual(requestsName, isEmptyArray), '浏览器 smoke 必须断言 request 采集集合');
  assert.ok(hasDeepEqual(consoleErrorsName, isEmptyArray), '浏览器 smoke 必须断言 console error 采集集合');
}

test('Go AST validator 拒绝 import、路由和中间件绕过', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'ttsync-b01-go-fixtures-'));
  try {
    const baseline = `package httpapi

import (
  "context"
  "io/fs"
  "net/http"

  "github.com/go-chi/chi/v5"
)

type Config struct {
  Ready func(context.Context) error
  Web fs.FS
}

func New(config Config) http.Handler {
  router := chi.NewRouter()
  router.Get("/health/live", func(http.ResponseWriter, *http.Request) {})
  router.Get("/health/ready", func(writer http.ResponseWriter, request *http.Request) {
    if config.Ready(request.Context()) != nil {
      writer.WriteHeader(http.StatusServiceUnavailable)
    }
  })
  router.NotFound(func(writer http.ResponseWriter, request *http.Request) {
    http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request)
  })
  return router
}`;
    assert.doesNotThrow(() => assertHttpapiAllowedSurface(inspectGoFiles([writeFixture(fixtureDirectory, 'baseline.go', baseline)])));

    const fixtures = [
      ['缺 Chi import 与 chi.NewRouter', baseline.replace('"github.com/go-chi/chi/v5"', '').replace('router := chi.NewRouter()', 'router := fakeRouter{}') + '\ntype fakeRouter struct{}\nfunc (fakeRouter) ServeHTTP(http.ResponseWriter, *http.Request) {}\nfunc (fakeRouter) Get(string, http.HandlerFunc) {}\nfunc (fakeRouter) NotFound(http.HandlerFunc) {}\n'],
      ['dot import', baseline.replace('"io/fs"', '. "io/fs"').replace('Web fs.FS', 'Web FS')],
      ['错误 Ready 类型', baseline.replace('Ready func(context.Context) error', 'Ready func(context.Context) any')],
      ['错误 Web 类型', baseline.replace('Web fs.FS', 'Web interface { Open(string) (fs.File, error) }')],
      ['缺 New(Config) http.Handler', baseline.replace('func New(config Config) http.Handler', 'func Routes(config Config) http.Handler')],
      ['Post 方法值别名', baseline.replace('return router', 'register := router.Post\n  register("/team", nil)\n  return router')],
      ['Route', baseline.replace('return router', 'router.Route("/team", nil)\n  return router')],
      ['Group', baseline.replace('return router', 'router.Group(nil)\n  return router')],
      ['Method', baseline.replace('return router', 'router.Method("GET", "/team", nil)\n  return router')],
      ['MethodFunc', baseline.replace('return router', 'router.MethodFunc("GET", "/team", nil)\n  return router')],
      ['Mount', baseline.replace('return router', 'router.Mount("/team", nil)\n  return router')],
      ['Use', baseline.replace('return router', 'router.Use(nil)\n  return router')],
      ['With chain', baseline.replace('return router', 'router.With(nil).Get("/team", nil)\n  return router')],
      ['Handle', baseline.replace('return router', 'router.Handle("/team", nil)\n  return router')],
      ['HandleFunc', baseline.replace('return router', 'router.HandleFunc("/team", nil)\n  return router')],
      ['Head', baseline.replace('return router', 'router.Head("/team", nil)\n  return router')],
      ['Options', baseline.replace('return router', 'router.Options("/team", nil)\n  return router')],
      ['Trace', baseline.replace('return router', 'router.Trace("/team", nil)\n  return router')],
      ['Connect', baseline.replace('return router', 'router.Connect("/team", nil)\n  return router')],
      ['Delete', baseline.replace('return router', 'router.Delete("/team", nil)\n  return router')],
      ['Get', baseline.replace('return router', 'router.Get("/team", nil)\n  return router')],
      ['Patch', baseline.replace('return router', 'router.Patch("/team", nil)\n  return router')],
      ['Post', baseline.replace('return router', 'router.Post("/team", nil)\n  return router')],
      ['Put', baseline.replace('return router', 'router.Put("/team", nil)\n  return router')],
      ['MethodNotAllowed', baseline.replace('return router', 'router.MethodNotAllowed(nil)\n  return router')],
      ['变量 path', baseline.replace('return router', 'path := "/team"\n  router.Get(path, nil)\n  return router')],
      ['换名包内逻辑', baseline.replace('return router', 'renamedLogic()\n  return router') + '\nfunc renamedLogic() {}\n'],
      ['包级协作者', baseline.replace('return router', 'collaborator()\n  return router') + '\nvar collaborator = func() {}\n'],
    ];
    const fixturePaths = fixtures.map(([name, source]) => writeFixture(fixtureDirectory, `${name}.go`, source));
    const inspectionByPath = new Map(
      inspectGoFiles(fixturePaths).flatMap((inspectedPackage) => inspectedPackage.Files.map((file) => [file.Path, inspectedPackage])),
    );
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
  const validSmoke = `import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
await page.goto('https://localhost:8443');
const requests = [];
page.on('request', (request) => requests.push(request.url()));
const expectedInteractiveControls = ['主持人视图', '参与者视图', '观众视图'];
const interactiveControls = await page.getByRole('tab').allTextContents();
assert.deepEqual(interactiveControls, expectedInteractiveControls);
assert.deepEqual(requests, []);
assert.deepEqual(consoleErrors, []);
await browser.close();`;
  assert.doesNotThrow(() => assertBrowserSmokeAllowedSurface(validSmoke));
  for (const [name, source] of [
    ['缺 Playwright import', validSmoke.replace("import { chromium } from 'playwright';\n", '')],
    ['缺 HTTPS goto', validSmoke.replace("await page.goto('https://localhost:8443');\n", '')],
    ['缺 DOM role 读取', validSmoke.replace("const interactiveControls = await page.getByRole('tab').allTextContents();\n", 'const interactiveControls = expectedInteractiveControls;\n')],
    ['请求监听未采集', validSmoke.replace("(request) => requests.push(request.url())", '() => {}')],
    ['console 监听未采集', validSmoke.replace("(message) => {\n  if (message.type() === 'error') consoleErrors.push(message.text());\n}", '() => {}')],
    ['使用未定义 requests', validSmoke.replace('const requests = [];\n', '')],
    ['语法无效', validSmoke.replace('const requests = [];', 'const requests = ;')],
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
  const appSource = readFileSync(requireFile('clients/web/src/App.vue'), 'utf8');
  const sourceFiles = filesUnder('clients/web/src').map((file) => relative(join(repositoryRoot, 'clients/web/src'), file)).sort();
  assert.deepEqual(sourceFiles, ['App.vue', 'main.ts', 'style.css'], 'B-01 客户端只允许空壳源文件');
  const clientPackage = JSON.parse(readFileSync(requireFile('clients/web/package.json'), 'utf8'));
  const allowedClientPackages = new Set(['vue', '@vitejs/plugin-vue', 'typescript', 'vite', 'vue-tsc']);
  const declaredClientPackages = [...Object.keys(clientPackage.dependencies ?? {}), ...Object.keys(clientPackage.devDependencies ?? {})];
  assert.ok(clientPackage.dependencies?.vue, 'B-01 客户端必须直接依赖 Vue');
  assert.deepEqual(
    declaredClientPackages.filter((packageName) => !allowedClientPackages.has(packageName)),
    [],
    'B-01 客户端依赖只允许 Vue 构建空壳所需包',
  );

  const allowedClientImports = new Set(['vue', './App.vue', './style.css']);
  const forbiddenClientSeams = /\b(?:fetch|axios|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|document\.cookie|createStore|useStore|dispatch|commit|emit|v-model)\b|\bimport\s*\(/;
  const forbiddenInternalImport = /(?:from\s+['"][^'"]*internal\/|require\(['"][^'"]*internal\/)/;
  for (const clientFile of filesUnder('clients/web/src')) {
    const source = readFileSync(clientFile, 'utf8');
    assert.deepEqual(
      moduleImportPaths(source).filter((importPath) => !allowedClientImports.has(importPath)),
      [],
      `B-01 客户端只允许 Vue 与本地空壳资源依赖：${relative(repositoryRoot, clientFile)}`,
    );
    assert.doesNotMatch(source, forbiddenClientSeams, `B-01 客户端不得拥有网络、领域命令或持久化状态 seam：${relative(repositoryRoot, clientFile)}`);
    assert.doesNotMatch(source, forbiddenInternalImport, `客户端不得直接依赖 Go 领域代码：${relative(repositoryRoot, clientFile)}`);
  }
  assert.doesNotMatch(
    appSource,
    /\b(?:function|async|await|computed|watch|watchEffect|defineEmits|defineProps)\b|=>/,
    'B-01 App.vue 只允许本地展示状态，不能容纳可扩展领域逻辑 seam',
  );
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
