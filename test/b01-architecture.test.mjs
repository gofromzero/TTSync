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
const identityPath = "github.com/gofromzero/ttsync/internal/identity"
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

const identityStub = "package identity\n" +
  "import (\"errors\"; \"time\")\n" +
  "var ErrInvalidEmail = errors.New(\"invalid email\")\n" +
  "var ErrInvalidPassword = errors.New(\"invalid password\")\n" +
  "var ErrInvalidToken = errors.New(\"invalid token\")\n" +
  "var ErrRateLimited = errors.New(\"rate limited\")\n" +
  "var ErrDeliveryUnavailable = errors.New(\"delivery unavailable\")\n" +
  "type RegisterCommand struct { Email, Password, IP, RequestID string; RequestTime time.Time }\n" +
  "type ResendVerificationCommand struct { Email, IP, RequestID string; RequestTime time.Time }\n" +
  "type VerifyEmailCommand struct { Token, IP, RequestID string; RequestTime time.Time }\n" +
  "type AcceptedResult struct{ Accepted bool }\n" +
  "type VerifiedResult struct{ Verified bool }\n"

type allowedImporter struct { standard types.Importer; chi *types.Package; identity *types.Package }

func newAllowedImporter() *allowedImporter {
  standard := importer.Default()
  fileSet := token.NewFileSet()
  file, error := parser.ParseFile(fileSet, "chi.go", chiStub, 0)
  if error != nil { panic(error) }
  configuration := types.Config{Importer: standard}
  chi, error := configuration.Check(chiPath, fileSet, []*ast.File{file}, nil)
  if error != nil { panic(error) }
  identityFile, error := parser.ParseFile(fileSet, "identity.go", identityStub, 0)
  if error != nil { panic(error) }
  identity, error := configuration.Check(identityPath, fileSet, []*ast.File{identityFile}, nil)
  if error != nil { panic(error) }
  return &allowedImporter{standard: standard, chi: chi, identity: identity}
}

func (value *allowedImporter) Import(path string) (*types.Package, error) {
  if path == chiPath { return value.chi, nil }
  if path == identityPath { return value.identity, nil }
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
  case *ast.ArrayType:
    return nil, "<slice-conversion>"
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

function assertClientAllowedSurface(sources, { requireId01 = false } = {}) {
  assert.deepEqual(Object.keys(sources).sort(), ['App.vue', 'main.ts', 'style.css'], 'B-01 客户端源文件必须精确为 App.vue、main.ts、style.css');

  const mainFile = ts.createSourceFile('main.ts', sources['main.ts'], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual(mainFile.parseDiagnostics ?? [], [], 'main.ts 必须是有效 TypeScript');
  assert.equal(mainFile.statements.length, 4, 'main.ts 只允许三个 import 与 Vue mount');
  const [vueImport, appImport, styleImport, mountStatement] = mainFile.statements;
  assert.ok(ts.isImportDeclaration(vueImport) && vueImport.moduleSpecifier.text === 'vue', 'main.ts 必须从 vue 导入 createApp');
  assert.deepEqual(
    vueImport.importClause?.namedBindings?.elements.map((element) => [element.propertyName?.text ?? element.name.text, element.name.text]),
    [['createApp', 'createApp']],
    'main.ts 的 Vue import 只允许 createApp',
  );
  assert.ok(ts.isImportDeclaration(appImport) && appImport.moduleSpecifier.text === './App.vue' && appImport.importClause?.name?.text === 'App' && !appImport.importClause.namedBindings, 'main.ts 必须默认导入 ./App.vue');
  assert.ok(ts.isImportDeclaration(styleImport) && styleImport.moduleSpecifier.text === './style.css' && !styleImport.importClause, 'main.ts 必须仅副作用导入 ./style.css');
  assert.ok(ts.isExpressionStatement(mountStatement), 'main.ts 最后必须直接 mount Vue');
  const mountCall = unwrappedExpression(mountStatement.expression);
  assert.ok(ts.isCallExpression(mountCall) && ts.isPropertyAccessExpression(mountCall.expression) && mountCall.expression.name.text === 'mount', 'main.ts 只允许 createApp(...).mount(...) 调用');
  const createCall = unwrappedExpression(mountCall.expression.expression);
  assert.ok(ts.isCallExpression(createCall) && ts.isIdentifier(createCall.expression) && createCall.expression.text === 'createApp' && createCall.arguments.length === 1 && ts.isIdentifier(createCall.arguments[0]) && createCall.arguments[0].text === 'App', 'main.ts 必须以 App 调用 createApp');
  assert.ok(mountCall.arguments.length === 1 && ts.isStringLiteralLike(mountCall.arguments[0]) && mountCall.arguments[0].text === '#app', 'Vue 只能 mount 到 #app');

  const appSource = sources['App.vue'];
  const scriptMatch = appSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/);
  const templateMatch = appSource.match(/<template>([\s\S]*?)<\/template>/);
  assert.ok(scriptMatch && templateMatch, 'App.vue 必须且只能提供 script setup lang=ts 与 template');
  assert.equal(appSource.replace(scriptMatch[0], '').replace(templateMatch[0], '').trim(), '', 'App.vue 不允许额外 block');
  const scriptFile = ts.createSourceFile('App.vue.ts', scriptMatch[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual(scriptFile.parseDiagnostics ?? [], [], 'App.vue script 必须是有效 TypeScript');
  const scriptImports = scriptFile.statements.filter(ts.isImportDeclaration);
  assert.equal(scriptImports.length, 1, 'App.vue 只能有一个 Vue import');
  assert.ok(scriptImports[0].moduleSpecifier.text === 'vue' && !scriptImports[0].importClause?.name, 'App.vue 只能从 vue 使用命名 import');
  const vueImports = scriptImports[0].importClause?.namedBindings?.elements.map((element) => element.name.text).sort();
  assert.ok(
    JSON.stringify(vueImports) === JSON.stringify(['ref'])
      || JSON.stringify(vueImports) === JSON.stringify(['onMounted', 'ref']),
    'App.vue 只允许 ref，或 ID-01 所需的 onMounted + ref',
  );
  const id01Client = vueImports.includes('onMounted');
  if (requireId01) assert.ok(id01Client, '真实客户端必须保留 ID-01 注册、重发与验证能力');

  const allowedInitializer = (node) => {
    const value = unwrappedExpression(node);
    if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind)) return true;
    if (ts.isArrayLiteralExpression(value)) return value.elements.every(allowedInitializer);
    if (ts.isObjectLiteralExpression(value)) return value.properties.every((property) => ts.isPropertyAssignment(property) && allowedInitializer(property.initializer));
    return ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'ref' && value.arguments.length === 1 && allowedInitializer(value.arguments[0]);
  };
  if (!id01Client) {
    for (const statement of scriptFile.statements.filter((statement) => !ts.isImportDeclaration(statement))) {
      assert.ok(ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0, 'B-01 App.vue script 只允许 const 本地展示状态');
      for (const declaration of statement.declarationList.declarations) {
        assert.ok(ts.isIdentifier(declaration.name) && declaration.initializer && allowedInitializer(declaration.initializer), 'B-01 App.vue 状态初值只允许字面量、数组、对象或 ref');
      }
    }
  } else {
    assert.ok(scriptFile.statements.every((statement) => ts.isImportDeclaration(statement)
      || ts.isVariableStatement(statement)
      || ts.isFunctionDeclaration(statement)
      || ts.isExpressionStatement(statement)), 'ID-01 App.vue 只允许 import、const、函数与 onMounted 注册');
    for (const statement of scriptFile.statements.filter(ts.isVariableStatement)) {
      assert.ok((statement.declarationList.flags & ts.NodeFlags.Const) !== 0, 'ID-01 App.vue 顶层状态必须使用 const');
    }

    const forbiddenGlobals = new Set([
      'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator', 'console', 'localStorage', 'sessionStorage',
      'indexedDB', 'globalThis', 'window', 'self', 'eval', 'Function',
    ]);
    for (const node of nodesUnder(scriptFile)) {
      if (ts.isIdentifier(node)) {
        assert.ok(!forbiddenGlobals.has(node.text), `ID-01 App.vue 不允许 Web API：${node.text}`);
      }
      if (ts.isStringLiteralLike(node)) {
        assert.doesNotMatch(node.text, /^(?:https?:)?\/\//i, 'ID-01 App.vue 不允许绝对或跨源 URL');
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'document') assert.equal(node.name.text, 'cookie', 'ID-01 App.vue document 只允许 cookie 读取');
        if (node.expression.text === 'location') assert.equal(node.name.text, 'search', 'ID-01 App.vue location 只允许 search 读取');
        if (node.expression.text === 'history') assert.equal(node.name.text, 'replaceState', 'ID-01 App.vue history 只允许 replaceState');
      }
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)
        && node.left.expression.getText(scriptFile) === 'document'
        && node.left.name.text === 'cookie') {
        assert.fail('ID-01 App.vue 只允许读取 document.cookie，不允许写入');
      }
    }

    const allowedPaths = [
      '/api/v1/accounts',
      '/api/v1/accounts/verification',
      '/api/v1/accounts/verification/resend',
    ];
    const postFunction = scriptFile.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'post');
    assert.ok(postFunction?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword), 'ID-01 App.vue 必须提供 async post helper');
    const pathType = postFunction.parameters[0]?.type;
    assert.ok(pathType && ts.isUnionTypeNode(pathType), 'post path 必须是三个固定路径的字面量 union');
    assert.deepEqual(
      pathType.types.map((type) => ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal) ? type.literal.text : '').sort(),
      allowedPaths,
      'post path 只允许三个 ID-01 literal endpoint',
    );

    const fetchReferences = nodesUnder(scriptFile).filter((node) => ts.isIdentifier(node) && node.text === 'fetch');
    assert.equal(fetchReferences.length, 1, 'ID-01 App.vue 原生 fetch 不得被别名、bind、属性或包装器引用');
    const fetchCalls = nodesUnder(scriptFile).filter((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch');
    assert.equal(fetchCalls.length, 1, 'ID-01 App.vue 必须且只能在 helper 内调用一次原生 fetch');
    const [fetchCall] = fetchCalls;
    assert.equal(fetchReferences[0], fetchCall.expression, 'ID-01 App.vue 每个 fetch 引用都必须是 post helper 的直接 callee');
    assert.ok(nodesUnder(postFunction.body).includes(fetchCall), 'ID-01 App.vue 原生 fetch 必须位于 post helper 内');
    assert.ok(ts.isIdentifier(fetchCall.arguments[0]) && fetchCall.arguments[0].text === postFunction.parameters[0].name.getText(scriptFile), 'fetch URL 必须来自固定 literal union path');
    const options = fetchCall.arguments[1];
    assert.ok(options && ts.isObjectLiteralExpression(options), 'fetch 必须提供固定 options');
    const property = (object, name) => object.properties.find((candidate) => ts.isPropertyAssignment(candidate)
      && ((ts.isIdentifier(candidate.name) || ts.isStringLiteralLike(candidate.name)) && candidate.name.text === name));
    assert.deepEqual(options.properties.map((candidate) => candidate.name?.text).sort(), ['body', 'credentials', 'headers', 'method'], 'fetch options 只允许固定四项');
    assert.ok(ts.isStringLiteralLike(property(options, 'method')?.initializer) && property(options, 'method').initializer.text === 'POST', 'fetch method 必须固定 POST');
    assert.ok(ts.isStringLiteralLike(property(options, 'credentials')?.initializer) && property(options, 'credentials').initializer.text === 'same-origin', 'fetch credentials 必须固定 same-origin');
    const headers = property(options, 'headers')?.initializer;
    assert.ok(headers && ts.isObjectLiteralExpression(headers), 'fetch 必须提供固定 JSON/CSRF headers');
    assert.deepEqual(headers.properties.map((candidate) => candidate.name?.text).sort(), ['Content-Type', 'X-CSRF-Token'], 'fetch headers 只允许 JSON 与 CSRF');
    assert.ok(ts.isStringLiteralLike(property(headers, 'Content-Type')?.initializer) && property(headers, 'Content-Type').initializer.text === 'application/json', 'Content-Type 必须固定 application/json');
    const csrfHeader = property(headers, 'X-CSRF-Token')?.initializer;
    assert.ok(csrfHeader && ts.isCallExpression(csrfHeader) && ts.isIdentifier(csrfHeader.expression) && csrfHeader.expression.text === 'csrf' && csrfHeader.arguments.length === 0, 'X-CSRF-Token 必须来自只读 cookie helper');
    const fetchBody = property(options, 'body')?.initializer;
    assert.ok(fetchBody && ts.isCallExpression(fetchBody)
      && fetchBody.expression.getText(scriptFile) === 'JSON.stringify'
      && fetchBody.arguments[0]?.getText(scriptFile) === postFunction.parameters[1].name.getText(scriptFile), 'fetch body 必须 JSON.stringify 原始 payload');
    const csrfDeclaration = scriptFile.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'csrf');
    assert.ok(csrfDeclaration?.initializer, 'ID-01 App.vue 必须提供只读 csrf helper');
    const documentReferences = nodesUnder(scriptFile).filter((node) => ts.isIdentifier(node) && node.text === 'document');
    assert.equal(documentReferences.length, 1, 'ID-01 App.vue document 不得被别名、写入或用于 cookie 以外能力');
    const cookieRead = documentReferences[0].parent;
    assert.ok(ts.isPropertyAccessExpression(cookieRead)
      && cookieRead.expression === documentReferences[0]
      && cookieRead.name.text === 'cookie'
      && nodesUnder(csrfDeclaration.initializer).includes(cookieRead), 'ID-01 App.vue document 只允许在 csrf helper 直接读取 document.cookie');
    assert.ok(!(ts.isBinaryExpression(cookieRead.parent) && cookieRead.parent.left === cookieRead)
      && !ts.isPrefixUnaryExpression(cookieRead.parent)
      && !ts.isPostfixUnaryExpression(cookieRead.parent)
      && !ts.isDeleteExpression(cookieRead.parent), 'ID-01 App.vue 只允许读取 document.cookie，不允许写入');
    assert.match(scriptMatch[1], /document\.cookie[\s\S]*__Host-ttsync-csrf=/, 'CSRF 必须只从首屏 cookie 读取');

    const postCalls = nodesUnder(scriptFile).filter((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'post');
    assert.equal(postCalls.length, 3, 'ID-01 App.vue 必须恰好调用三个固定 POST');
    const allowedPostReferences = new Set([postFunction.name, ...postCalls.map((call) => call.expression)]);
    const postReferences = nodesUnder(scriptFile).filter((node) => ts.isIdentifier(node) && node.text === 'post');
    assert.equal(postReferences.length, 4, 'ID-01 App.vue post helper 不得被别名、bind、属性、传递、返回或包装引用');
    assert.ok(postReferences.every((reference) => allowedPostReferences.has(reference)), 'ID-01 App.vue post helper 只允许声明名与三个直接调用 callee');
    const requestFields = new Map([
      ['/api/v1/accounts', ['email', 'password']],
      ['/api/v1/accounts/verification/resend', ['email']],
      ['/api/v1/accounts/verification', ['token']],
    ]);
    for (const call of postCalls) {
      assert.ok(ts.isStringLiteralLike(call.arguments[0]) && requestFields.has(call.arguments[0].text), 'post 调用不得使用动态或其他 API URL');
      const body = call.arguments[1];
      assert.ok(body && ts.isObjectLiteralExpression(body), 'post payload 必须是对象字面量');
      assert.deepEqual(body.properties.map((candidate) => candidate.name?.text).sort(), requestFields.get(call.arguments[0].text), `${call.arguments[0].text} payload 字段必须精确`);
    }
    const searchParams = nodesUnder(scriptFile).filter((node) => ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'URLSearchParams');
    assert.equal(searchParams.length, 1, '验证页必须且只能读取一次 URLSearchParams');
    assert.equal(searchParams[0].arguments?.[0]?.getText(scriptFile), 'location.search', 'URLSearchParams 只允许读取 location.search');
    assert.match(scriptMatch[1], /history\.replaceState\(null,\s*['"]['"],\s*['"]\/verify['"]\)/, '读取 token 后必须清除地址栏查询参数');
  }

  const allowedElements = new Set(['main', 'header', 'section', 'div', 'h1', 'h2', 'p', 'nav', 'button', 'span', 'strong', 'form', 'label', 'input']);
  const allowedAttributes = new Set(['class', 'id', 'for', 'name', 'type', 'role', 'tabindex', 'autocomplete', 'aria-label', 'aria-selected', 'aria-controls', 'aria-live', 'v-for', 'v-if', 'v-else-if', 'v-else', 'v-model', ':key', ':class', ':aria-selected', ':disabled', '@click', '@submit.prevent']);
  const urlAttributes = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'xlink:href']);
  const tabClickExpressions = [];
  const submitExpressions = [];
  const formLabels = [];
  for (const match of templateMatch[1].matchAll(/<\s*(\/)?([A-Za-z][\w-]*)([^>]*)>/g)) {
    if (match[1]) continue;
    assert.ok(allowedElements.has(match[2]), `App.vue template 元素不在允许面：${match[2]}`);
    const clickMatches = [...match[3].matchAll(/@click\s*=\s*(?:"([^"]*)"|'([^']*)')/g)];
    const isRoleTabButton = match[2] === 'button' && /\brole\s*=\s*(?:"tab"|'tab')/.test(match[3]);
    if (isRoleTabButton) {
      assert.equal(clickMatches.length, 1, 'App.vue 每个三角色 tab 必须恰好一个 @click');
      tabClickExpressions.push(clickMatches[0][1] ?? clickMatches[0][2]);
    } else {
      assert.equal(clickMatches.length, 0, 'App.vue @click 只允许三角色 tab');
    }
    const submitMatches = [...match[3].matchAll(/@submit\.prevent\s*=\s*(?:"([^"]*)"|'([^']*)')/g)];
    if (match[2] === 'form') {
      assert.equal(submitMatches.length, 1, 'ID-01 每个 form 必须恰好一个原生 submit handler');
      submitExpressions.push(submitMatches[0][1] ?? submitMatches[0][2]);
      formLabels.push(match[3].match(/\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/)?.slice(1).find(Boolean));
    } else {
      assert.equal(submitMatches.length, 0, '@submit.prevent 只允许用于 form');
    }
    const remainder = match[3].replace(/([:@]?[A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'))?/g, (attribute, name) => {
      assert.ok(!urlAttributes.has(name), `App.vue template 不允许任何 URL scheme：${name}`);
      assert.ok(allowedAttributes.has(name), `App.vue template 属性不在允许面：${name}`);
      return '';
    });
    assert.equal(remainder.trim(), '', `App.vue template 属性语法不在允许面：${remainder.trim()}`);
  }
  assert.deepEqual(
    tabClickExpressions.sort(),
    ["activeRole = 'host'", "activeRole = 'participant'", "activeRole = 'spectator'"].sort(),
    'App.vue 三角色 tab 的 @click 只允许精确本地 activeRole 赋值',
  );
  const allowedTemplateExpressions = new Set([
    "activeRole = 'host'",
    "activeRole = 'participant'",
    "activeRole = 'spectator'",
    'activeRole',
    ...(id01Client ? [
      "activeRole === 'host'",
      "activeRole === 'participant'",
      "activeRole === 'spectator'",
      'email',
      'password',
      'resendEmail',
      'submitting',
      'registering',
      'resending',
      'register',
      'resend',
      'registerMessage',
      'resendMessage',
      'verificationMessage',
    ] : []),
  ]);
  const templateExpressions = [
    ...[...templateMatch[1].matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1].trim()),
    ...[...templateMatch[1].matchAll(/(?:v-(?:if|else-if|model)|:[A-Za-z_][\w:.-]*|@[A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map((match) => (match[1] ?? match[2]).trim()),
  ];
  for (const expression of templateExpressions) {
    assert.ok(allowedTemplateExpressions.has(expression), `App.vue template 表达式不在精确允许面：${expression}`);
  }
  if (id01Client) {
    assert.deepEqual(submitExpressions.sort(), ['register', 'resend'], 'ID-01 template 只允许注册与重发两个 submit handler');
    assert.deepEqual(formLabels.sort(), ['创建账号', '重发验证邮件'], 'ID-01 两个 form 必须用精确 aria-label 区分真实浏览器操作');
    assert.match(templateMatch[1], /<label\b[^>]*for=(?:"|')register-email(?:"|')[^>]*>[\s\S]*?<input\b[^>]*id=(?:"|')register-email(?:"|')[^>]*type=(?:"|')email(?:"|')/, '注册邮箱必须有明确 label 与原生 email input');
    assert.match(templateMatch[1], /<label\b[^>]*for=(?:"|')register-password(?:"|')[^>]*>[\s\S]*?<input\b[^>]*id=(?:"|')register-password(?:"|')[^>]*type=(?:"|')password(?:"|')/, '注册密码必须有明确 label 与原生 password input');
    assert.match(templateMatch[1], /role=(?:"|')status(?:"|')[^>]*aria-live=(?:"|')polite(?:"|')/, 'ID-01 状态区域必须是 aria-live status');
  }
  assert.doesNotMatch(sources['style.css'], /@(?:import|font-face)|\burl\s*\(|\bexpression\s*\(/i, 'style.css 不允许外链或可执行资源');
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

function writeGoPackageFixture(directory, name, sources) {
  const fixtureDirectory = join(directory, name.replaceAll(/[\\/:*?"<>|.]/g, '-'));
  mkdirSync(fixtureDirectory);
  return Object.entries(sources).map(([fileName, source]) => {
    const fixturePath = join(fixtureDirectory, fileName);
    writeFileSync(fixturePath, source);
    return fixturePath;
  });
}

function assertHttpapiAllowedSurface(inspection) {
  assert.equal(inspection.length, 1, 'HTTP adapter 必须作为单一 Go package 检查');
  const [inspectedPackage] = inspection;
  assert.deepEqual(inspectedPackage.TypeErrors, [], `HTTP adapter 必须通过 go/types：${inspectedPackage.TypeErrors.join('; ')}`);
  const files = inspectedPackage.Files;
  assert.deepEqual(
    files.map((file) => basename(file.Path)).sort(),
    ['router.go', 'web.go'],
    'internal/httpapi 生产文件必须精确为 router.go 与 web.go',
  );
  const allowedImports = new Set([
    'context',
    'crypto/rand',
    'crypto/subtle',
    'embed',
    'encoding/base64',
    'encoding/hex',
    'encoding/json',
    'errors',
    'fmt',
    'io',
    'io/fs',
    'mime',
    'net',
    'net/http',
    'net/url',
    'path',
    'strings',
    'time',
    'github.com/go-chi/chi/v5',
    'github.com/gofromzero/ttsync/internal/identity',
  ]);
  const configFiles = files.filter((file) => file.ConfigFields.length > 0);
  assert.equal(configFiles.length, 1, 'HTTP adapter 必须只定义一个 Config 协作者面');
  assert.deepEqual(
    configFiles[0].ConfigFields,
    [
      { Name: 'Ready', Type: 'func(context.Context) error', Tag: '' },
      { Name: 'Web', Type: 'fs.FS', Tag: '' },
      { Name: 'PublicOrigin', Type: 'string', Tag: '' },
      { Name: 'Register', Type: 'func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error)', Tag: '' },
      { Name: 'ResendVerification', Type: 'func(context.Context, identity.ResendVerificationCommand) (identity.AcceptedResult, error)', Tag: '' },
      { Name: 'VerifyEmail', Type: 'func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error)', Tag: '' },
    ],
    'Config 必须精确为 Ready、Web、PublicOrigin 与三个 identity 方法值',
  );

  for (const file of files) {
    for (const imported of file.Imports) {
      assert.notEqual(imported.Name, '.', `internal/httpapi 不得使用 dot import：${imported.Path}`);
      assert.ok(imported.Name === '' || (imported.Name === '_' && imported.Path === 'embed'), `internal/httpapi 不得改名或旁路 import：${imported.Name} ${imported.Path}`);
      assert.ok(!imported.Path.includes('/internal/') || imported.Path === 'github.com/gofromzero/ttsync/internal/identity', `internal/httpapi 只可导入 identity internal 包：${imported.Path}`);
      assert.ok(allowedImports.has(imported.Path), `internal/httpapi 依赖不在允许面：${imported.Path}`);
    }
  }

  const routerFile = files.find((file) => basename(file.Path) === 'router.go');
  assert.ok(routerFile, 'HTTP adapter 必须包含 router.go');
  const webFile = files.find((file) => basename(file.Path) === 'web.go');
  assert.ok(webFile, 'HTTP adapter 必须包含 web.go');
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
  const allowedIdentityPaths = new Set(['/api/v1/accounts', '/api/v1/accounts/verification/resend', '/api/v1/accounts/verification']);
  const allowedFallbackPaths = new Set(['/', '/*']);
  assert.ok(registrations.some((call) => call.Name === 'Get' && call.Arguments[0]?.Kind === 'string' && call.Arguments[0].Value === '/health/live'), '必须注册 /health/live');
  assert.ok(registrations.some((call) => call.Name === 'Get' && call.Arguments[0]?.Kind === 'string' && call.Arguments[0].Value === '/health/ready'), '必须注册 /health/ready');

  const assertInlineHTTPHandler = (argument, label) => {
    if (argument?.Kind !== 'expression') {
      throw new assert.AssertionError({ message: `${label} 必须直接使用 inline func，不能从其他声明注入 handler` });
    }
    assert.match(
      argument.Value,
      /^func\((?:[A-Za-z_]\w*\s+)?http\.ResponseWriter,\s*(?:[A-Za-z_]\w*\s+)?\*http\.Request\)\s*\{/,
      `${label} inline func 参数必须精确为 (http.ResponseWriter, *http.Request)`,
    );
  };

  for (const call of registrations) {
    const path = call.Arguments[0];
    if (call.Name === 'NotFound') {
      assert.equal(call.Arguments.length, 1, 'NotFound 必须只接收一个 inline SPA handler');
      assertInlineHTTPHandler(call.Arguments[0], 'NotFound handler');
      continue;
    }
    assert.equal(path?.Kind, 'string', `路由路径必须是字面量：${call.Receiver}.${call.Name}`);
    const isHealthRead = call.Name === 'Get' && allowedHealthPaths.has(path.Value);
    const isIdentityWrite = call.Name === 'Post' && allowedIdentityPaths.has(path.Value);
    const isSpaFallback = ['Get', 'Handle', 'HandleFunc'].includes(call.Name) && allowedFallbackPaths.has(path.Value);
    assert.ok(isHealthRead || isIdentityWrite || isSpaFallback, `HTTP adapter 不得注册未授权领域路由、写路由或中间件：${call.Receiver}.${call.Name} ${path.Value}`);
    assert.equal(call.Arguments.length, 2, `${path.Value} 必须只接收路径与 handler`);
    assertInlineHTTPHandler(call.Arguments[1], `${path.Value} handler`);
  }
  assert.ok(
    registrations.some((call) => call.Name === 'NotFound') || registrations.some((call) => ['/', '/*'].includes(call.Arguments[0]?.Value)),
    'B-01 必须提供 SPA fallback',
  );

  assert.ok(routerFile.Calls.some((call) => call.Function === 'New' && call.Receiver === configName && call.Name === 'Ready' && call.ObjectKind === 'var'), 'readiness 必须调用 Config.Ready');
  for (const method of ['Register', 'ResendVerification', 'VerifyEmail']) {
    assert.ok(routerFile.Calls.some((call) => call.Function === 'New' && call.Receiver === configName && call.Name === method && call.ObjectKind === 'var'), `HTTP adapter 必须调用 Config.${method}`);
  }
  assert.ok(routerFile.Selectors.some((selector) => selector.Function === 'New' && selector.Receiver === configName && selector.Name === 'Web' && selector.ObjectKind === 'var'), 'SPA 必须消费 Config.Web');

  const allowedStandardCallPackages = new Set(['crypto/rand', 'crypto/subtle', 'encoding/base64', 'encoding/hex', 'encoding/json', 'errors', 'fmt', 'io', 'io/fs', 'mime', 'net', 'net/http', 'net/url', 'path', 'strings', 'time']);
  const allowedLocalAdapterCalls = new Set(['newRequestID', 'writeProblem', 'writeValidation', 'mapError', 'decodeJSON', 'exactKeys', 'authorize', 'requestIP', 'issueCSRF']);
  for (const call of routerFile.Calls.filter((candidate) => candidate.Function === 'New')) {
    const isChi = call.Package === 'github.com/go-chi/chi/v5';
    const isStandard = allowedStandardCallPackages.has(call.Package);
    const isConfigMethod = call.Receiver === configName && ['Ready', 'Register', 'ResendVerification', 'VerifyEmail'].includes(call.Name) && call.ObjectKind === 'var';
    const isBuiltin = call.Package === '' && call.ObjectKind === 'builtin' && ['append', 'len', 'make'].includes(call.Name);
    const isLocalAdapter = call.Receiver === '' && call.ObjectKind === 'var' && allowedLocalAdapterCalls.has(call.Name);
    const isSliceConversion = call.Package === '' && call.ObjectKind === 'unknown' && call.Name === '<slice-conversion>';
    assert.ok(isChi || isStandard || isConfigMethod || isBuiltin || isLocalAdapter || isSliceConversion, `router.go New 调用不在允许面：${call.Receiver ? `${call.Receiver}.` : ''}${call.Name} ${JSON.stringify(call)}`);
  }

  const webSource = readFileSync(webFile.Path, 'utf8');
  const embeddedDeclaration = webSource.match(/^\/\/go:embed web\/dist\/\*\r?\nvar ([A-Za-z_]\w*) embed\.FS$/m);
  assert.ok(embeddedDeclaration, 'web.go 必须且只能以 embed.FS 承载 //go:embed web/dist/*');
  const embeddedName = embeddedDeclaration[1];
  assert.deepEqual(
    webFile.TopLevels,
    [
      { Kind: 'var', Names: [embeddedName] },
      { Kind: 'func', Names: ['WebAssets'] },
    ],
    'web.go 顶层只允许嵌入资产与 WebAssets seam',
  );
  assert.deepEqual(
    webFile.Imports,
    [
      { Name: '', Path: 'embed' },
      { Name: '', Path: 'io/fs' },
    ],
    'web.go 只能导入 embed 与 io/fs',
  );
  assert.deepEqual(
    webFile.Functions,
    [{ Name: 'WebAssets', Receiver: false, TypeParameters: 0, Parameters: [], Results: ['fs.FS'] }],
    'web.go 只能公开 WebAssets() fs.FS',
  );
  for (const call of webFile.Calls) {
    const isSub = call.Function === 'WebAssets' && call.Package === 'io/fs' && call.Name === 'Sub';
    const isPanic = call.Function === 'WebAssets' && call.Package === '' && call.ObjectKind === 'builtin' && call.Name === 'panic';
    assert.ok(isSub || isPanic, `web.go 调用不在静态资产允许面：${call.Receiver ? `${call.Receiver}.` : ''}${call.Name}`);
  }
}

test('ID-01 HTTP adapter 允许三个固定 POST 与 identity 方法值', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'ttsync-id01-http-fixture-'));
  try {
    const router = `package httpapi

import (
  "context"
  "io/fs"
  "net/http"

  "github.com/go-chi/chi/v5"
  "github.com/gofromzero/ttsync/internal/identity"
)

type Config struct {
  Ready func(context.Context) error
  Web fs.FS
  PublicOrigin string
  Register func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error)
  ResendVerification func(context.Context, identity.ResendVerificationCommand) (identity.AcceptedResult, error)
  VerifyEmail func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error)
}

func New(config Config) http.Handler {
  router := chi.NewRouter()
  router.Get("/health/live", func(http.ResponseWriter, *http.Request) {})
  router.Get("/health/ready", func(writer http.ResponseWriter, request *http.Request) {
    if config.Ready(request.Context()) != nil { writer.WriteHeader(http.StatusServiceUnavailable) }
  })
  router.Post("/api/v1/accounts", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.Register(request.Context(), identity.RegisterCommand{}) })
  router.Post("/api/v1/accounts/verification/resend", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.ResendVerification(request.Context(), identity.ResendVerificationCommand{}) })
  router.Post("/api/v1/accounts/verification", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.VerifyEmail(request.Context(), identity.VerifyEmailCommand{}) })
  router.NotFound(func(writer http.ResponseWriter, request *http.Request) {
    http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request)
  })
  return router
}`;
    const web = `package httpapi

import (
  "embed"
  "io/fs"
)

//go:embed web/dist/*
var embeddedWeb embed.FS

func WebAssets() fs.FS { return embeddedWeb }
`;
    assert.doesNotThrow(() => assertHttpapiAllowedSurface(inspectGoFiles(writeGoPackageFixture(fixtureDirectory, '合法 ID-01 HTTP adapter', { 'router.go': router, 'web.go': web }))));
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('Go AST validator 独立拒绝 New 内局部 handler 变量', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'ttsync-id01-local-handler-fixture-'));
  try {
    const router = `package httpapi

import (
  "context"
  "io/fs"
  "net/http"

  "github.com/go-chi/chi/v5"
  "github.com/gofromzero/ttsync/internal/identity"
)

type Config struct {
  Ready func(context.Context) error
  Web fs.FS
  PublicOrigin string
  Register func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error)
  ResendVerification func(context.Context, identity.ResendVerificationCommand) (identity.AcceptedResult, error)
  VerifyEmail func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error)
}

func New(config Config) http.Handler {
  router := chi.NewRouter()
  router.Get("/health/live", func(http.ResponseWriter, *http.Request) {})
  router.Get("/health/ready", func(writer http.ResponseWriter, request *http.Request) {
    if config.Ready(request.Context()) != nil { writer.WriteHeader(http.StatusServiceUnavailable) }
  })
  registerHandler := func(_ http.ResponseWriter, request *http.Request) { _, _ = config.Register(request.Context(), identity.RegisterCommand{}) }
  router.Post("/api/v1/accounts", registerHandler)
  router.Post("/api/v1/accounts/verification/resend", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.ResendVerification(request.Context(), identity.ResendVerificationCommand{}) })
  router.Post("/api/v1/accounts/verification", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.VerifyEmail(request.Context(), identity.VerifyEmailCommand{}) })
  router.NotFound(func(writer http.ResponseWriter, request *http.Request) { http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request) })
  return router
}`;
    const web = `package httpapi

import (
  "embed"
  "io/fs"
)

//go:embed web/dist/*
var embeddedWeb embed.FS

func WebAssets() fs.FS { return embeddedWeb }
`;
    const inspection = inspectGoFiles(writeGoPackageFixture(fixtureDirectory, '局部 handler 变量', { 'router.go': router, 'web.go': web }));
    let diagnostic = '';
    try {
      assertHttpapiAllowedSurface(inspection);
    } catch (error) {
      diagnostic = error.message;
    }
    assert.equal(diagnostic, '/api/v1/accounts handler 必须直接使用 inline func，不能从其他声明注入 handler');
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

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
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return bindings;
}

function expressionReferencesIdentifier(expression, identifierName) {
  return nodesUnder(expression).some((node) => ts.isIdentifier(node) && node.text === identifierName);
}

function reachableStatementContains(statement, target) {
  if (ts.isBlock(statement)) {
    return reachableStatementsContain(statement.statements, target);
  }
  if (ts.isIfStatement(statement)) {
    if (statement.expression.kind !== ts.SyntaxKind.FalseKeyword && nodesUnder(statement.thenStatement).includes(target)) {
      return reachableStatementContains(statement.thenStatement, target);
    }
    return Boolean(statement.elseStatement)
      && nodesUnder(statement.elseStatement).includes(target)
      && reachableStatementContains(statement.elseStatement, target);
  }
  return nodesUnder(statement).includes(target);
}

function reachableStatementsContain(statements, target) {
  for (const statement of statements) {
    if (reachableStatementContains(statement, target)) {
      return true;
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      return false;
    }
  }
  return false;
}

function topLevelCallRecords(sourceFile) {
  const records = [];
  sourceFile.statements.forEach((statement, index) => {
    if (!ts.isExpressionStatement(statement)) {
      return;
    }
    const expression = unwrappedExpression(statement.expression);
    if (ts.isCallExpression(expression)) {
      records.push({ call: expression, index });
    }
  });
  return records;
}

function assertBrowserSmokeAllowedSurface(source) {
  const virtualPath = join(tmpdir(), 'ttsync-b01-browser-smoke.mjs');
  const sourceFile = ts.createSourceFile(virtualPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.deepEqual(sourceFile.parseDiagnostics ?? [], [], '浏览器 smoke 必须是有效 JavaScript 语法');

  let runtimeProgram = sourceFile;
  const registeredTest = sourceFile.statements.find((statement) => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression)
    && ts.isIdentifier(statement.expression.expression)
    && statement.expression.expression.text === 'test');
  if (registeredTest) {
    const callback = registeredTest.expression.arguments[2];
    assert.ok(callback && ts.isArrowFunction(callback) && callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) && ts.isBlock(callback.body), '浏览器 smoke test 必须使用 async callback');
    const tryIndex = callback.body.statements.findIndex(ts.isTryStatement);
    assert.ok(tryIndex >= 0, '浏览器 smoke 必须用 try/finally 包裹 browser 运行面');
    const tryStatement = callback.body.statements[tryIndex];
    runtimeProgram = { statements: [...callback.body.statements.slice(0, tryIndex), ...tryStatement.tryBlock.statements] };
  }

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

  const bindings = variableBindings(runtimeProgram);
  const bindingPositions = new Map();
  runtimeProgram.statements.forEach((statement, index) => {
    if (!ts.isVariableStatement(statement)) {
      return;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        bindingPositions.set(declaration.name.text, index);
      }
    }
  });
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

  const callRecords = topLevelCallRecords(runtimeProgram);
  const calls = callRecords.map(({ call }) => call);
  const callPosition = (target) => callRecords.find(({ call }) => call === target)?.index;
  const gotoCalls = nodesUnder(sourceFile).filter((node) => ts.isCallExpression(node) && propertyCall(node, pageName, 'goto'));
  assert.equal(gotoCalls.length, 1, '浏览器 smoke 全文件只能调用一次 page.goto');
  const [gotoCall] = gotoCalls;
  const gotoStatements = runtimeProgram.statements.filter((statement) => ts.isExpressionStatement(statement)
    && ts.isAwaitExpression(statement.expression)
    && propertyCall(statement.expression, pageName, 'goto'));
  assert.equal(gotoStatements.length, 1, 'page.goto 必须是顶层 awaited expression');
  assert.equal(unwrappedExpression(gotoStatements[0].expression), gotoCall, 'page.goto 不得藏在变量初始化或嵌套函数中');
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
    const listenerPosition = callPosition(listener);
    assert.ok(reachableStatementContains(callback.body, pushCall), 'page ' + eventName + ' listener 的 collector 写入必须可达');
    const collectorName = pushCall.expression.expression.text;
    const collectorInitializer = bindings.get(collectorName);
    assert.ok(collectorInitializer && ts.isArrayLiteralExpression(collectorInitializer), 'page ' + eventName + ' collector 必须是已定义数组');
    assert.ok(bindingPositions.get(collectorName) < listenerPosition, 'page ' + eventName + ' collector 必须先声明再注册 listener');
    assert.ok(listenerPosition < callPosition(gotoCall), 'page ' + eventName + ' listener 必须早于 page.goto 注册');
    return collectorName;
  };

  const requestsName = collectorForEvent('request');
  const consoleErrorsName = collectorForEvent('console');
  const isEmptyArray = (value) => ts.isArrayLiteralExpression(value) && value.elements.length === 0;
  const requestAssertion = calls.find((call) => ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === assertName
    && call.expression.name.text === 'deepEqual'
    && ts.isIdentifier(call.arguments[0])
    && call.arguments[0].text === requestsName
    && isEmptyArray(call.arguments[1]));
  const consoleAssertion = calls.find((call) => ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === assertName
    && call.expression.name.text === 'deepEqual'
    && ts.isIdentifier(call.arguments[0])
    && call.arguments[0].text === consoleErrorsName
    && isEmptyArray(call.arguments[1]));
  assert.ok(requestAssertion, '浏览器 smoke 必须在顶层可达路径断言 request 采集集合');
  assert.ok(consoleAssertion, '浏览器 smoke 必须在顶层可达路径断言 console error 采集集合');
  assert.ok(callPosition(gotoCall) < callPosition(requestAssertion), 'request 最终断言必须位于 page.goto 之后');
  assert.ok(callPosition(gotoCall) < callPosition(consoleAssertion), 'console 最终断言必须位于 page.goto 之后');
}

function assertId01BrowserSmokeAllowedSurface(source) {
  const sourceFile = ts.createSourceFile('id01-browser-smoke.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.deepEqual(sourceFile.parseDiagnostics ?? [], [], 'ID-01 browser smoke 必须是有效 JavaScript');
  assert.doesNotMatch(source, /process\.exit\s*\(|console\.(?:log|info|warn|error)\s*\(/, 'ID-01 browser smoke 不得退出或打印');

  const registeredTest = sourceFile.statements.find((statement) => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression)
    && ts.isIdentifier(statement.expression.expression)
    && statement.expression.expression.text === 'test')?.expression;
  assert.ok(registeredTest && registeredTest.arguments.length === 3, 'ID-01 browser smoke 必须注册带 option 的 node:test');
  const testOptions = registeredTest.arguments[1];
  assert.ok(testOptions && ts.isObjectLiteralExpression(testOptions), 'ID-01 browser smoke 必须提供显式 skip option');
  const skipProperty = testOptions.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'skip');
  assert.equal(skipProperty?.initializer.getText(sourceFile), "process.env.B01_RUN_BROWSER_SMOKE !== '1'", 'ID-01 browser smoke 必须复用 B01_RUN_BROWSER_SMOKE opt-in 并显式 skip');
  const callback = registeredTest.arguments[2];
  assert.ok(callback && ts.isArrowFunction(callback) && callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) && ts.isBlock(callback.body), 'ID-01 browser smoke 必须使用 async callback');
  const tryIndex = callback.body.statements.findIndex(ts.isTryStatement);
  assert.ok(tryIndex >= 0, 'ID-01 browser smoke 必须在 browser launch 后使用 try/finally');
  const tryStatement = callback.body.statements[tryIndex];
  assert.ok(tryStatement.finallyBlock, 'ID-01 browser smoke 必须提供 finally');
  const runtimeProgram = { statements: [...callback.body.statements.slice(0, tryIndex), ...tryStatement.tryBlock.statements] };
  const bindings = variableBindings(runtimeProgram);
  const browserBinding = [...bindings.entries()].find(([, initializer]) => propertyCall(initializer, 'chromium', 'launch'));
  assert.ok(browserBinding, 'ID-01 browser smoke 必须启动真实 Chromium');
  const [browserName] = browserBinding;
  assert.ok(nodesUnder(tryStatement.finallyBlock).some((node) => propertyCall(node, browserName, 'close')), 'ID-01 browser smoke finally 必须关闭 browser');
  const contextBinding = [...bindings.entries()].find(([, initializer]) => propertyCall(initializer, browserName, 'newContext'));
  assert.ok(contextBinding && contextBinding[1].getText(sourceFile).includes('ignoreHTTPSErrors: true'), 'ID-01 Chromium context 必须允许本地 Caddy 证书');
  const [contextName] = contextBinding;
  const pageBinding = [...bindings.entries()].find(([, initializer]) => propertyCall(initializer, contextName, 'newPage'));
  assert.ok(pageBinding, 'ID-01 browser smoke 必须创建真实 page');
  const [pageName] = pageBinding;

  assert.match(source, /const baseUrl = process\.env\.B01_BASE_URL \?\? 'https:\/\/localhost:8443';/, 'ID-01 browser smoke 默认入口必须为 Caddy HTTPS');
  assert.match(source, /const baseOrigin = new URL\(baseUrl\)\.origin;/, 'ID-01 browser smoke 必须导出严格 origin');
  assert.match(source, /process\.env\.ID01_COMPOSE_PROJECT/, 'ID-01 browser smoke 必须读取精确 Compose project');
  assert.match(source, /process\.env\.ID01_COMPOSE_FILE/, 'ID-01 browser smoke 必须读取精确 Compose file');

  const callRecords = topLevelCallRecords(runtimeProgram);
  const gotoCalls = callRecords.filter(({ call }) => propertyCall(call, pageName, 'goto'));
  assert.equal(gotoCalls.length, 5, 'ID-01 browser smoke 必须真实导航首屏、旧 token、新 token、重放和重复注册');
  assert.ok(gotoCalls.every(({ call }) => call.arguments[0] && (ts.isIdentifier(call.arguments[0]) || ts.isStringLiteralLike(call.arguments[0]))), 'ID-01 browser smoke 导航目标必须来自受控 URL');
  const firstGotoPosition = gotoCalls[0].index;
  const collectorForEvent = (eventName) => {
    const record = callRecords.find(({ call }) => {
      const onCall = propertyCall(call, pageName, 'on');
      return onCall?.arguments[0] && ts.isStringLiteralLike(onCall.arguments[0]) && onCall.arguments[0].text === eventName;
    });
    assert.ok(record && record.index < firstGotoPosition, `ID-01 ${eventName} listener 必须早于首次 goto`);
    const listener = record.call.arguments[1];
    assert.ok(listener && (ts.isArrowFunction(listener) || ts.isFunctionExpression(listener)), `ID-01 ${eventName} listener 必须是函数`);
    assert.equal(listener.parameters.length, 1, `ID-01 ${eventName} listener 必须接收一个标识符参数`);
    assert.ok(ts.isIdentifier(listener.parameters[0].name), `ID-01 ${eventName} listener 必须接收一个标识符参数`);
    const eventNameIdentifier = listener.parameters[0].name.text;
    const push = nodesUnder(listener.body).find((node) => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'push'
      && node.arguments.some((argument) => expressionReferencesIdentifier(argument, eventNameIdentifier)));
    assert.ok(push && reachableStatementContains(listener.body, push), `ID-01 ${eventName} listener 必须采集真实事件`);
    return { listener, eventNameIdentifier, push, collector: push.expression.expression.getText(sourceFile) };
  };
  const requestCollector = collectorForEvent('request');
  assert.ok(nodesUnder(requestCollector.listener.body).some((node) => ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    && node.left.getText(sourceFile) === 'new URL(request.url()).origin'
    && node.right.getText(sourceFile) === 'baseOrigin'), 'ID-01 request listener 必须用 URL.origin 严格判同源');
  assert.doesNotMatch(requestCollector.listener.getText(sourceFile), /startsWith/, 'ID-01 request listener 不得用 startsWith 判同源');
  const consoleCollector = collectorForEvent('console');
  const consolePushes = nodesUnder(consoleCollector.listener.body).filter((node) => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText(sourceFile) === consoleCollector.collector
    && node.expression.name.text === 'push');
  assert.deepEqual(consolePushes, [consoleCollector.push], 'ID-01 console listener 必须把所有 error 采集到唯一 collector，不得按 422 文本分流');
  const consoleGuard = nodesUnder(consoleCollector.listener.body).find((node) => ts.isIfStatement(node)
    && nodesUnder(node.thenStatement).includes(consoleCollector.push));
  assert.ok(consoleGuard
    && !consoleGuard.elseStatement
    && ts.isBinaryExpression(consoleGuard.expression)
    && consoleGuard.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && propertyCall(consoleGuard.expression.left, consoleCollector.eventNameIdentifier, 'type')
    && ts.isStringLiteralLike(consoleGuard.expression.right)
    && consoleGuard.expression.right.text === 'error', 'ID-01 console listener 必须无条件采集每一条 error，不得按诊断文本豁免');
  const consoleEntry = consoleCollector.push.arguments[0];
  assert.ok(consoleEntry && ts.isObjectLiteralExpression(consoleEntry), 'ID-01 console collector 必须同时保存完整文本与来源 URL');
  const consoleEntryProperty = (name) => consoleEntry.properties.find((property) => ts.isPropertyAssignment(property)
    && property.name.getText(sourceFile) === name)?.initializer;
  assert.deepEqual(consoleEntry.properties.map((property) => property.name?.getText(sourceFile)).sort(), ['text', 'url'], 'ID-01 console collector 只允许保存 text 与 url');
  assert.ok(propertyCall(consoleEntryProperty('text'), consoleCollector.eventNameIdentifier, 'text'), 'ID-01 console collector 必须保存完整 message.text()');
  const consoleLocationUrl = consoleEntryProperty('url');
  assert.ok(ts.isPropertyAccessExpression(consoleLocationUrl)
    && consoleLocationUrl.name.text === 'url'
    && propertyCall(consoleLocationUrl.expression, consoleCollector.eventNameIdentifier, 'location'), 'ID-01 console collector 必须保存 message.location().url 以绑定响应');
  const responseCollector = collectorForEvent('response');

  const finalDeepEqual = (collector) => {
    const assertion = callRecords.find(({ call, index }) => index > gotoCalls.at(-1).index
      && ts.isPropertyAccessExpression(call.expression)
      && call.expression.getText(sourceFile) === 'assert.deepEqual'
      && call.arguments[0]?.getText(sourceFile) === collector
      && ts.isArrayLiteralExpression(call.arguments[1])
      && call.arguments[1].elements.length === 0);
    assert.ok(assertion, `ID-01 browser smoke 必须在全部导航后断言 ${collector} 为零`);
    return assertion;
  };
  const finalRequestAssertion = finalDeepEqual(requestCollector.collector);
  const finalConsoleAssertion = finalDeepEqual(consoleCollector.collector);
  assert.equal(responseCollector.collector, 'apiResponses', 'ID-01 response listener 必须采集真实 POST 响应');

  const composeAppShell = nodesUnder(sourceFile).find((node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'composeExec'
    && node.arguments[0]?.getText(sourceFile) === "'app'"
    && node.arguments[1]?.getText(sourceFile) === "'sh'"
    && node.arguments[2]?.getText(sourceFile) === "'-c'");
  assert.ok(composeAppShell && ts.isNoSubstitutionTemplateLiteral(composeAppShell.arguments[3]), 'outbox 必须由精确 docker compose exec -T app sh -c 读取');
  const outboxCommand = composeAppShell.arguments[3].text;
  assert.match(outboxCommand, /^stat -c %a \/tmp\/ttsync-outbox$/m, 'outbox 必须读取目录 Linux mode');
  assert.match(outboxCommand, /^\s*stat -c %a "\$file"$/m, 'outbox 必须读取每个邮件文件 Linux mode');
  assert.match(outboxCommand, /\/tmp\/ttsync-outbox\/\*\.eml/, 'outbox 只能从容器内默认目录读取 eml');
  assert.ok(nodesUnder(sourceFile).some((node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'composeExec'
    && node.arguments[0]?.getText(sourceFile) === "'postgres'"
    && node.arguments.some((argument) => argument.getText(sourceFile) === "'psql'")), '数据库状态必须经同一精确 Compose project 的 postgres psql 查询');
  const appLogs = bindings.get('appLogs');
  assert.ok(appLogs && ts.isCallExpression(appLogs)
    && ts.isIdentifier(appLogs.expression)
    && appLogs.expression.text === 'execFileSync'
    && appLogs.arguments[0]?.getText(sourceFile) === "'docker'"
    && ts.isArrayLiteralExpression(appLogs.arguments[1])
    && JSON.stringify(appLogs.arguments[1].elements.map((element) => element.getText(sourceFile))) === JSON.stringify([
      "'compose'", "'-p'", 'composeProject', "'-f'", 'composeFile', "'logs'", "'--no-color'", "'app'",
    ]), '秘密扫描必须读取同一精确 Compose project 的 app 日志');

  const waitResponses = nodesUnder(tryStatement.tryBlock).filter((node) => propertyCall(node, pageName, 'waitForResponse'));
  assert.equal(waitResponses.length, 6, 'ID-01 browser smoke 必须等待 register、resend、旧/新/replay verify 与 duplicate 真实响应');
  const waitedPaths = waitResponses.map((call) => {
    const literals = nodesUnder(call.arguments[0]).filter(ts.isStringLiteralLike).map((node) => node.text);
    return literals.find((value) => value.startsWith('/api/'));
  }).sort();
  assert.deepEqual(waitedPaths, [
    '/api/v1/accounts',
    '/api/v1/accounts',
    '/api/v1/accounts/verification',
    '/api/v1/accounts/verification',
    '/api/v1/accounts/verification',
    '/api/v1/accounts/verification/resend',
  ], 'ID-01 browser smoke 必须等待真实 register/resend/old/new/replay/duplicate endpoint');

  const bindingPosition = (name) => tryStatement.tryBlock.statements.findIndex((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name));
  const criticalAssertion = (method, predicate, label) => {
    const matches = nodesUnder(tryStatement.tryBlock).filter((node) => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(sourceFile) === 'assert'
      && node.expression.name.text === method
      && predicate(node.arguments));
    assert.equal(matches.length, 1, `ID-01 browser smoke 必须恰好提供 ${label}`);
    const [call] = matches;
    assert.ok(ts.isExpressionStatement(call.parent) && unwrappedExpression(call.parent.expression) === call, `${label} 必须是直接执行的断言语句`);
    assert.ok(call.parent.parent === tryStatement.tryBlock, `${label} 必须是 browser try block statement list 的直接表达式，不得藏在 catch、条件、循环或函数中`);
    return { call, position: tryStatement.tryBlock.statements.indexOf(call.parent) };
  };
  const afterBinding = (assertion, bindingName, label) => {
    const position = bindingPosition(bindingName);
    assert.ok(position >= 0 && assertion.position > position, `${label} 必须位于 ${bindingName} 真实动作/响应之后`);
  };
  const responseStatusAssertion = (responseName, status, label) => {
    const assertion = criticalAssertion('equal', (args) => propertyCall(args[0], responseName, 'status')
      && ts.isNumericLiteral(args[1])
      && args[1].text === String(status), label);
    afterBinding(assertion, responseName, label);
    return assertion;
  };
  const responseEvidence = [
    ['firstRegister', 200, '首次注册 200 断言'],
    ['resendResult', 200, '重发 200 断言'],
    ['oldTokenResult', 422, '旧 token 422 断言'],
    ['newTokenResult', 200, '新 token 200 断言'],
    ['replay', 422, '重放 422 断言'],
    ['duplicateResult', 200, '重复注册 200 断言'],
  ];
  const responseAssertions = new Map(responseEvidence.map(([name, status, label]) => [name, responseStatusAssertion(name, status, label)]));

  const stateEvidence = [
    ['pendingAfterRegister', '1|pending_verification', 'firstRegister'],
    ['pendingAfterOldToken', '1|pending_verification', 'oldTokenResult'],
    ['activeAfterNewToken', '1|active', 'newTokenResult'],
    ['activeAfterReplay', '1|active', 'replay'],
    ['activeAfterDuplicate', '1|active', 'duplicateResult'],
  ];
  for (const [stateName, expected, responseName] of stateEvidence) {
    const initializer = bindings.get(stateName);
    assert.ok(initializer && ts.isCallExpression(initializer)
      && ts.isIdentifier(initializer.expression)
      && initializer.expression.text === 'accountState'
      && initializer.arguments[0]?.getText(sourceFile) === 'email', `${stateName} 必须来自真实 accountState(email)`);
    const stateAssertion = criticalAssertion('equal', (args) => args[0]?.getText(sourceFile) === stateName
      && ts.isStringLiteralLike(args[1])
      && args[1].text === expected, `${stateName} DB 状态断言`);
    afterBinding(stateAssertion, stateName, `${stateName} DB 状态断言`);
    assert.ok(bindingPosition(stateName) > responseAssertions.get(responseName).position, `${stateName} 必须在 ${responseName} 真实响应后读取`);
  }

  const outboxEvidence = (outboxName, responseName) => {
    const initializer = bindings.get(outboxName);
    assert.ok(initializer && ts.isCallExpression(initializer)
      && ts.isIdentifier(initializer.expression)
      && initializer.expression.text === 'readOutbox'
      && initializer.arguments.length === 0, `${outboxName} 必须直接读取真实 outbox`);
    const modeAssertion = criticalAssertion('equal', (args) => args[0]?.getText(sourceFile) === `${outboxName}.directoryMode`
      && ts.isStringLiteralLike(args[1])
      && args[1].text === '700', `${outboxName} 700 断言`);
    afterBinding(modeAssertion, outboxName, `${outboxName} 700 断言`);
    const fileModeAssertion = criticalAssertion('ok', (args) => {
      const every = unwrappedExpression(args[0]);
      if (!ts.isCallExpression(every)
        || !ts.isPropertyAccessExpression(every.expression)
        || every.expression.expression.getText(sourceFile) !== `${outboxName}.messages`
        || every.expression.name.text !== 'every') return false;
      const callback = every.arguments[0];
      assert.ok(callback && ts.isArrowFunction(callback)
        && callback.parameters.length === 1
        && ts.isIdentifier(callback.parameters[0].name), `${outboxName} 文件 mode callback 必须接收一个标识符参数`);
      const parameter = callback.parameters[0].name.text;
      return ts.isBinaryExpression(callback.body)
        && callback.body.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && callback.body.left.getText(sourceFile) === `${parameter}.mode`
        && ts.isStringLiteralLike(callback.body.right)
        && callback.body.right.text === '600';
    }, `${outboxName} 文件 600 断言`);
    afterBinding(fileModeAssertion, outboxName, `${outboxName} 文件 600 断言`);
    assert.ok(bindingPosition(outboxName) > responseAssertions.get(responseName).position, `${outboxName} 必须在 ${responseName} 真实响应后读取`);
  };
  outboxEvidence('firstOutbox', 'firstRegister');
  outboxEvidence('secondOutbox', 'resendResult');
  outboxEvidence('finalOutbox', 'duplicateResult');
  for (const [messagesName, label] of [['linkedMessages', '首次验证邮件数量'], ['resendMessages', '重发验证邮件数量'], ['duplicateMessages', '重复注册通用邮件数量']]) {
    const countAssertion = criticalAssertion('equal', (args) => args[0]?.getText(sourceFile) === `${messagesName}.length`
      && ts.isNumericLiteral(args[1])
      && args[1].text === '1', `${label}断言`);
    afterBinding(countAssertion, messagesName, `${label}断言`);
  }
  const tokenRotationAssertion = criticalAssertion('notEqual', (args) => args[0]?.getText(sourceFile) === 'newToken'
    && args[1]?.getText(sourceFile) === 'token', '重发 token 换代断言');
  afterBinding(tokenRotationAssertion, 'newToken', '重发 token 换代断言');
  afterBinding(tokenRotationAssertion, 'token', '重发 token 换代断言');

  const waits = nodesUnder(tryStatement.tryBlock).filter((node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'setTimeout');
  assert.equal(waits.length, 2, 'ID-01 browser smoke 只允许两次真实 target 一分钟等待');
  const waitPositions = waits.map((wait) => {
    assert.ok(ts.isNumericLiteral(wait.arguments[1]) && wait.arguments[1].text === '61000', 'target 限速等待必须超过一分钟');
    return tryStatement.tryBlock.statements.findIndex((statement) => nodesUnder(statement).includes(wait));
  });
  assert.ok(waitPositions[0] > bindingPosition('token') && waitPositions[0] < bindingPosition('resendResponse'), '首次等待必须只位于注册 token 与重发之间');
  assert.ok(waitPositions[1] > bindingPosition('replay') && waitPositions[1] < bindingPosition('duplicateResponse'), '第二次等待必须只位于即时重放与重复注册之间');

  const passwordLogAssertion = criticalAssertion('ok', (args) => ts.isPrefixUnaryExpression(args[0])
    && args[0].operator === ts.SyntaxKind.ExclamationToken
    && propertyCall(args[0].operand, 'appLogs', 'includes')?.arguments[0]?.getText(sourceFile) === 'password', 'app 日志密码断言');
  afterBinding(passwordLogAssertion, 'appLogs', 'app 日志密码断言');
  const tokenLogAssertion = criticalAssertion('ok', (args) => ts.isPrefixUnaryExpression(args[0])
    && args[0].operator === ts.SyntaxKind.ExclamationToken
    && propertyCall(args[0].operand, 'appLogs', 'includes')?.arguments[0]?.getText(sourceFile) === 'token', 'app 日志 token 断言');
  afterBinding(tokenLogAssertion, 'appLogs', 'app 日志 token 断言');
  const newTokenLogAssertion = criticalAssertion('ok', (args) => ts.isPrefixUnaryExpression(args[0])
    && args[0].operator === ts.SyntaxKind.ExclamationToken
    && propertyCall(args[0].operand, 'appLogs', 'includes')?.arguments[0]?.getText(sourceFile) === 'newToken', 'app 日志重发 token 断言');
  afterBinding(newTokenLogAssertion, 'appLogs', 'app 日志重发 token 断言');
  const cookiesBinding = bindings.get('cookies');
  assert.ok(propertyCall(cookiesBinding, contextName, 'cookies'), 'ID-01 browser smoke 必须从真实 context 获取 cookies');
  afterBinding(passwordLogAssertion, 'cookies', 'app 日志密码断言');
  afterBinding(tokenLogAssertion, 'cookies', 'app 日志 token 断言');
  const csrfCookieBinding = bindings.get('csrfCookie');
  const csrfFind = propertyCall(csrfCookieBinding, 'cookies', 'find');
  const csrfFindCallback = csrfFind?.arguments[0];
  assert.ok(csrfFindCallback && ts.isArrowFunction(csrfFindCallback), 'CSRF cookie find 必须使用 arrow callback');
  assert.ok(csrfFindCallback.parameters.length === 1 && ts.isIdentifier(csrfFindCallback.parameters[0].name), 'CSRF cookie find callback 必须接收一个标识符参数');
  assert.ok(
    ts.isBinaryExpression(csrfFindCallback.body)
    && csrfFindCallback.body.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && csrfFindCallback.body.left.getText(sourceFile) === `${csrfFindCallback.parameters[0].name.text}.name`
    && ts.isStringLiteralLike(csrfFindCallback.body.right)
    && csrfFindCallback.body.right.text === '__Host-ttsync-csrf', 'ID-01 browser smoke 必须按精确名称查找 CSRF cookie');
  const csrfCookieAssertion = criticalAssertion('ok', (args) => args[0]?.getText(sourceFile) === 'csrfCookie?.value', '命名 CSRF cookie 非空断言');
  afterBinding(csrfCookieAssertion, 'appLogs', '命名 CSRF cookie 非空断言');
  afterBinding(csrfCookieAssertion, 'cookies', '命名 CSRF cookie 非空断言');
  afterBinding(csrfCookieAssertion, 'csrfCookie', '命名 CSRF cookie 非空断言');
  const cookiesEveryAssertion = (predicate, label) => criticalAssertion('ok', (args) => {
    const every = propertyCall(args[0], 'cookies', 'every');
    const everyCallback = every?.arguments[0];
    if (!everyCallback) return false;
    assert.ok(ts.isArrowFunction(everyCallback), 'cookie every 必须使用 arrow callback');
    assert.ok(everyCallback.parameters.length === 1 && ts.isIdentifier(everyCallback.parameters[0].name), 'cookie every callback 必须接收一个标识符参数');
    return predicate(everyCallback.body, everyCallback.parameters[0].name.text);
  }, label);
  const cookieValuesNonempty = cookiesEveryAssertion((body, cookieName) => ts.isBinaryExpression(body)
    && body.operatorToken.kind === ts.SyntaxKind.GreaterThanToken
    && body.left.getText(sourceFile) === `${cookieName}.value.length`
    && ts.isNumericLiteral(body.right)
    && body.right.text === '0', '全部 cookie 值非空断言');
  afterBinding(cookieValuesNonempty, 'cookies', '全部 cookie 值非空断言');
  afterBinding(cookieValuesNonempty, 'appLogs', '全部 cookie 值非空断言');
  const cookieValuesAbsent = cookiesEveryAssertion((body, cookieName) => ts.isPrefixUnaryExpression(body)
    && body.operator === ts.SyntaxKind.ExclamationToken
    && propertyCall(body.operand, 'appLogs', 'includes')?.arguments[0]?.getText(sourceFile) === `${cookieName}.value`, '全部 cookie 值日志排除断言');
  afterBinding(cookieValuesAbsent, 'appLogs', '全部 cookie 值日志排除断言');
  afterBinding(cookieValuesAbsent, 'cookies', '全部 cookie 值日志排除断言');

  const consoleEvidence = (expectedName, indexName, responseName, label) => {
    const expected = bindings.get(expectedName);
    assert.ok(expected && ts.isObjectLiteralExpression(expected), `${label} 必须构造精确 console 诊断`);
    const property = (name) => expected.properties.find((candidate) => ts.isPropertyAssignment(candidate)
      && candidate.name.getText(sourceFile) === name)?.initializer;
    assert.deepEqual(expected.properties.map((candidate) => candidate.name?.getText(sourceFile)).sort(), ['text', 'url'], `${label} console 诊断只允许 text 与 url`);
    const expectedText = property('text');
    assert.ok(ts.isTemplateExpression(expectedText)
      && expectedText.head.text === 'Failed to load resource: the server responded with a status of '
      && expectedText.templateSpans.length === 1
      && propertyCall(expectedText.templateSpans[0].expression, responseName, 'status')
      && expectedText.templateSpans[0].literal.text === ' ()', `${label} console 文本必须精确绑定真实响应 status`);
    assert.ok(propertyCall(property('url'), responseName, 'url'), `${label} console 诊断必须绑定真实响应 URL`);
    const index = bindings.get(indexName);
    const find = propertyCall(index, consoleCollector.collector, 'findIndex');
    const callback = find?.arguments[0];
    assert.ok(find && callback && ts.isArrowFunction(callback), 'console findIndex 必须使用 arrow callback');
    assert.ok(callback.parameters.length === 1 && ts.isIdentifier(callback.parameters[0].name), 'console findIndex callback 必须接收一个标识符参数');
    assert.ok(ts.isBinaryExpression(callback.body)
      && callback.body.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && callback.body.left.getText(sourceFile) === `${callback.parameters[0].name.text}.url`
      && propertyCall(callback.body.right, responseName, 'url'), `${label} console 诊断必须按真实响应 URL 查找`);
    const presence = criticalAssertion('notEqual', (args) => args[0]?.getText(sourceFile) === indexName
      && ts.isPrefixUnaryExpression(args[1])
      && args[1].operator === ts.SyntaxKind.MinusToken
      && ts.isNumericLiteral(args[1].operand)
      && args[1].operand.text === '1', `${label} console URL 绑定断言`);
    afterBinding(presence, indexName, `${label} console URL 绑定断言`);
    assert.ok(presence.position > responseAssertions.get(responseName).position, `${label} console 断言必须位于真实响应之后`);
    const removal = criticalAssertion('deepEqual', (args) => propertyCall(args[0], consoleCollector.collector, 'splice')?.arguments[0]?.getText(sourceFile) === indexName
      && propertyCall(args[0], consoleCollector.collector, 'splice').arguments[1]?.getText(sourceFile) === '1'
      && ts.isArrayLiteralExpression(args[1])
      && args[1].elements.length === 1
      && args[1].elements[0].getText(sourceFile) === expectedName, `${label} console 精确消费断言`);
    afterBinding(removal, indexName, `${label} console 精确消费断言`);
  };
  consoleEvidence('expectedOldTokenConsoleError', 'oldTokenConsoleErrorIndex', 'oldTokenResult', '旧 token 422');
  consoleEvidence('expectedReplayConsoleError', 'replayConsoleErrorIndex', 'replay', '重放 422');

  for (const responseName of ['oldTokenResult', 'replay']) {
    const codeAssertion = criticalAssertion('equal', (args) => args[0]?.getText(sourceFile) === `(await ${responseName}.json()).code`
      && ts.isStringLiteralLike(args[1])
      && args[1].text === 'VALIDATION_FAILED', `${responseName} Problem code 断言`);
    assert.ok(codeAssertion.position > responseAssertions.get(responseName).position, `${responseName} Problem code 必须位于真实响应之后`);
  }

  const finalEvidenceAssertion = finalRequestAssertion.index > finalConsoleAssertion.index ? finalRequestAssertion : finalConsoleAssertion;
  const earlyTermination = nodesUnder(tryStatement.tryBlock).find((node) => node.getStart(sourceFile) < finalEvidenceAssertion.call.getStart(sourceFile)
    && (ts.isReturnStatement(node)
      || ts.isThrowStatement(node)
      || (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'process.exit')));
  assert.ok(!earlyTermination, 'ID-01 browser smoke 不得在最终证据序列前 return、throw 或 process.exit');

  const genericReceipt = criticalAssertion('match', (args) => args[0]?.getText(sourceFile) === 'duplicateMessages[0].body'
    && ts.isRegularExpressionLiteral(args[1])
    && args[1].text === '/Your request was received\\./', '重复注册通用回执断言');
  afterBinding(genericReceipt, 'duplicateMessages', '重复注册通用回执断言');
  const genericNoLink = criticalAssertion('doesNotMatch', (args) => args[0]?.getText(sourceFile) === 'duplicateMessages[0].body'
    && ts.isRegularExpressionLiteral(args[1])
    && args[1].text === '/\\/verify\\?token=/', '重复注册无链接断言');
  afterBinding(genericNoLink, 'duplicateMessages', '重复注册无链接断言');
  const expectedApiSequence = [
    ['/api/v1/accounts', '200'],
    ['/api/v1/accounts/verification/resend', '200'],
    ['/api/v1/accounts/verification', '422'],
    ['/api/v1/accounts/verification', '200'],
    ['/api/v1/accounts/verification', '422'],
    ['/api/v1/accounts', '200'],
  ];
  const apiSequence = criticalAssertion('deepEqual', (args) => args[0]?.getText(sourceFile) === 'apiResponses'
    && ts.isArrayLiteralExpression(args[1])
    && args[1].elements.length === expectedApiSequence.length
    && args[1].elements.every((element, index) => ts.isArrayLiteralExpression(element)
      && element.elements.length === 2
      && ts.isStringLiteralLike(element.elements[0])
      && element.elements[0].text === expectedApiSequence[index][0]
      && ts.isNumericLiteral(element.elements[1])
      && element.elements[1].text === expectedApiSequence[index][1]), 'API 动作顺序断言');
  assert.ok(apiSequence.position > responseAssertions.get('duplicateResult').position, 'API 动作顺序必须在全部真实响应后断言');

  const tryText = tryStatement.tryBlock.getText(sourceFile);
  assert.match(source, /const acceptedMessage = '请求已受理，请查收邮件。';/, '注册与重复注册必须断言逐字相同的通用文案');
  assert.ok((tryText.match(/getByText\(acceptedMessage, \{ exact: true \}\)/g) ?? []).length >= 3, '注册、重发与重复注册必须从各自真实 UI 读取同一通用文案');
  for (const message of ['邮箱已验证。', '验证链接无效或已失效。']) assert.ok(tryText.includes(message), `ID-01 browser smoke 缺少 UI 结果：${message}`);
  assert.match(source, /'compose', '-p', composeProject, '-f', composeFile, 'exec', '-T', service/, 'compose helper 必须固定 project/file/exec -T');
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
  "github.com/gofromzero/ttsync/internal/identity"
)

type Config struct {
  Ready func(context.Context) error
  Web fs.FS
  PublicOrigin string
  Register func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error)
  ResendVerification func(context.Context, identity.ResendVerificationCommand) (identity.AcceptedResult, error)
  VerifyEmail func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error)
}

func New(config Config) http.Handler {
  router := chi.NewRouter()
  router.Get("/health/live", func(http.ResponseWriter, *http.Request) {})
  router.Get("/health/ready", func(writer http.ResponseWriter, request *http.Request) {
    if config.Ready(request.Context()) != nil {
      writer.WriteHeader(http.StatusServiceUnavailable)
    }
  })
  router.Post("/api/v1/accounts", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.Register(request.Context(), identity.RegisterCommand{}) })
  router.Post("/api/v1/accounts/verification/resend", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.ResendVerification(request.Context(), identity.ResendVerificationCommand{}) })
  router.Post("/api/v1/accounts/verification", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.VerifyEmail(request.Context(), identity.VerifyEmailCommand{}) })
  router.NotFound(func(writer http.ResponseWriter, request *http.Request) {
    http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request)
  })
  return router
}`;
    const web = `package httpapi

import (
  "embed"
  "io/fs"
)

//go:embed web/dist/*
var embeddedWeb embed.FS

func WebAssets() fs.FS { return embeddedWeb }
`;
    assert.doesNotThrow(() => assertHttpapiAllowedSurface(inspectGoFiles(writeGoPackageFixture(fixtureDirectory, 'baseline', { 'router.go': baseline, 'web.go': web }))));

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
    const fixturePaths = fixtures.map(([name, source]) => writeGoPackageFixture(fixtureDirectory, name, { 'router.go': source, 'web.go': web }));
    const inspectionByDirectory = new Map(inspectGoFiles(fixturePaths.flat()).map((inspectedPackage) => [inspectedPackage.Directory, inspectedPackage]));
    for (const [index, [name]] of fixtures.entries()) {
      assert.throws(
        () => assertHttpapiAllowedSurface([inspectionByDirectory.get(dirname(fixturePaths[index][0]))]),
        assert.AssertionError,
        `Go AST validator 必须拒绝 ${name}`,
      );
    }
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('Go AST validator 拒绝跨文件声明与 handler 注入', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'ttsync-b01-go-package-fixtures-'));
  try {
    const router = `package httpapi

import (
  "context"
  "io/fs"
  "net/http"

  "github.com/go-chi/chi/v5"
  "github.com/gofromzero/ttsync/internal/identity"
)

type Config struct {
  Ready func(context.Context) error
  Web fs.FS
  PublicOrigin string
  Register func(context.Context, identity.RegisterCommand) (identity.AcceptedResult, error)
  ResendVerification func(context.Context, identity.ResendVerificationCommand) (identity.AcceptedResult, error)
  VerifyEmail func(context.Context, identity.VerifyEmailCommand) (identity.VerifiedResult, error)
}

func New(config Config) http.Handler {
  router := chi.NewRouter()
  router.Get("/health/live", func(http.ResponseWriter, *http.Request) {})
  router.Get("/health/ready", func(writer http.ResponseWriter, request *http.Request) {
    if config.Ready(request.Context()) != nil {
      writer.WriteHeader(http.StatusServiceUnavailable)
    }
  })
  router.Post("/api/v1/accounts", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.Register(request.Context(), identity.RegisterCommand{}) })
  router.Post("/api/v1/accounts/verification/resend", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.ResendVerification(request.Context(), identity.ResendVerificationCommand{}) })
  router.Post("/api/v1/accounts/verification", func(_ http.ResponseWriter, request *http.Request) { _, _ = config.VerifyEmail(request.Context(), identity.VerifyEmailCommand{}) })
  router.NotFound(func(writer http.ResponseWriter, request *http.Request) {
    http.FileServer(http.FS(config.Web)).ServeHTTP(writer, request)
  })
  return router
}`;
    const web = `package httpapi

import (
  "embed"
  "io/fs"
)

//go:embed web/dist/*
var embeddedWeb embed.FS

func WebAssets() fs.FS { return embeddedWeb }
`;
    const baselinePaths = writeGoPackageFixture(fixtureDirectory, '合法双文件包', { 'router.go': router, 'web.go': web });
    assert.doesNotThrow(() => assertHttpapiAllowedSurface(inspectGoFiles(baselinePaths)));

    const declarationBypass = web.replace('  "io/fs"', '  "io/fs"\n  "net/http"') + `
var packageCollaborator = func() {}
func init() { packageCollaborator() }
func hiddenHandler(http.ResponseWriter, *http.Request) {}
func (Config) HiddenMethod() {}
`;
    const injectedHandlerRouter = router.replace('func(http.ResponseWriter, *http.Request) {}', 'healthHandler');
    const handlerBypass = `package httpapi

import "net/http"

var healthHandler http.HandlerFunc = func(http.ResponseWriter, *http.Request) {}
`;

    for (const [name, sources] of [
      ['web.go 藏包级声明、init、函数与 Config method', { 'router.go': router, 'web.go': declarationBypass }],
      ['额外文件注入 health handler', { 'router.go': injectedHandlerRouter, 'web.go': web, 'handlers.go': handlerBypass }],
    ]) {
      assert.throws(
        () => assertHttpapiAllowedSurface(inspectGoFiles(writeGoPackageFixture(fixtureDirectory, name, sources))),
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
const requests = [];
page.on('request', (request) => {
  if (!request.url().startsWith('https://localhost:8443')) requests.push(request.url());
});
await page.goto('https://localhost:8443');
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
    ['变量初始化中的首次导航与后置 decoy goto', validSmoke.replace(
      'const consoleErrors = [];',
      "const firstNavigation = await page.goto('https://localhost:8443');\nconst consoleErrors = [];",
    )],
    ['嵌套函数中的隐藏 goto', validSmoke.replace(
      'const consoleErrors = [];',
      "async function hideNavigation() { await page.goto('https://localhost:8443'); }\nconst consoleErrors = [];",
    )],
    ['goto 早于 request listener', validSmoke.replace("await page.goto('https://localhost:8443');\n", '').replace('const requests = [];\n', "await page.goto('https://localhost:8443');\nconst requests = [];\n")],
    ['缺 DOM role 读取', validSmoke.replace("const interactiveControls = await page.getByRole('tab').allTextContents();\n", 'const interactiveControls = expectedInteractiveControls;\n')],
    ['请求监听未采集', validSmoke.replace("(request) => {\n  if (!request.url().startsWith('https://localhost:8443')) requests.push(request.url());\n}", '() => {}')],
    ['console 监听未采集', validSmoke.replace("(message) => {\n  if (message.type() === 'error') consoleErrors.push(message.text());\n}", '() => {}')],
    ['使用未定义 requests', validSmoke.replace('const requests = [];\n', '')],
    ['request listener 写入不可达', validSmoke.replace("if (!request.url().startsWith('https://localhost:8443')) requests.push(request.url());", "return;\n  requests.push(request.url());")],
    ['最终 request 断言不可达', validSmoke.replace('assert.deepEqual(requests, []);', 'if (false) assert.deepEqual(requests, []);')],
    ['语法无效', validSmoke.replace('const requests = [];', 'const requests = ;')],
  ]) {
    assert.throws(() => assertBrowserSmokeAllowedSurface(source), assert.AssertionError, `浏览器 smoke validator 必须拒绝 ${name}`);
  }
});

test('ID-01 browser smoke 使用独立的完整纵向验收允许面', () => {
  const id01Smoke = readFileSync(requireFile('test/id01-browser-smoke.mjs'), 'utf8');
  assert.doesNotThrow(() => assertId01BrowserSmokeAllowedSurface(id01Smoke));
  const mutate = (needle, replacement) => {
    assert.ok(id01Smoke.includes(needle), `ID-01 mutation 缺少锚点：${needle}`);
    return id01Smoke.replace(needle, replacement);
  };
  const moveBefore = (line, anchor) => {
    assert.ok(id01Smoke.includes(`${line}\n`) && id01Smoke.includes(anchor), `ID-01 顺序 mutation 缺少锚点：${line}`);
    return id01Smoke.replace(`${line}\n`, '').replace(anchor, `${line}\n${anchor}`);
  };
  for (const [name, source, expectedMessage] of [
    ['伪装 PASS 而非显式 skip', mutate("skip: process.env.B01_RUN_BROWSER_SMOKE !== '1'", 'skip: false')],
    ['非 HTTPS 首屏', mutate("'https://localhost:8443'", "'http://localhost:8443'")],
    ['request listener startsWith', mutate('new URL(request.url()).origin !== baseOrigin', '!request.url().startsWith(baseUrl)')],
    ['request listener 无参数', mutate("page.on('request', (request) =>", "page.on('request', () =>"), /ID-01 request listener 必须接收一个标识符参数/],
    ['request listener 后置 decoy', mutate("    page.on('request',", "    await page.goto(baseUrl);\n    page.on('request',")],
    ['缺 response 采集', mutate('apiResponses.push([new URL(response.url()).pathname, response.status()]);', 'void response;')],
    ['outbox 非 app 容器', mutate("const output = composeExec('app', 'sh', '-c'", "const output = composeExec('postgres', 'sh', '-c'")],
    ['目录权限 decoy', mutate('stat -c %a /tmp/ttsync-outbox', 'true # stat -c %a /tmp/ttsync-outbox')],
    ['文件权限 decoy', mutate('  stat -c %a "$file"', '  true # stat -c %a "$file"')],
    ['首次注册状态错误', mutate('assert.equal(firstRegister.status(), 200);', 'assert.equal(firstRegister.status(), 201);')],
    ['重发状态错误', mutate('assert.equal(resendResult.status(), 200);', 'assert.equal(resendResult.status(), 201);')],
    ['旧 token 冒充 429', mutate('assert.equal(oldTokenResult.status(), 422);', 'assert.equal(oldTokenResult.status(), 429);')],
    ['新 token 状态错误', mutate('assert.equal(newTokenResult.status(), 200);', 'assert.equal(newTokenResult.status(), 201);')],
    ['即时重放冒充 429', mutate('assert.equal(replay.status(), 422);', 'assert.equal(replay.status(), 429);')],
    ['重复注册状态错误', mutate('assert.equal(duplicateResult.status(), 200);', 'assert.equal(duplicateResult.status(), 201);')],
    ['首次 pending DB 断言不可达', mutate("assert.equal(pendingAfterRegister, '1|pending_verification');", "if (false) assert.equal(pendingAfterRegister, '1|pending_verification');"), /pendingAfterRegister DB 状态断言 必须是 browser try block statement list 的直接表达式/],
    ['旧 token 后 pending DB 断言仅为字符串', mutate("assert.equal(pendingAfterOldToken, '1|pending_verification');", 'void "pendingAfterOldToken === pending_verification";'), /必须恰好提供 pendingAfterOldToken DB 状态断言/],
    ['新 token 后 active DB 断言藏入死函数', mutate("assert.equal(activeAfterNewToken, '1|active');", "function deadStateCheck() { assert.equal(activeAfterNewToken, '1|active'); }"), /activeAfterNewToken DB 状态断言 必须是 browser try block statement list 的直接表达式/],
    ['重放后 active DB 断言不可达', mutate("assert.equal(activeAfterReplay, '1|active');", "if (false) assert.equal(activeAfterReplay, '1|active');"), /activeAfterReplay DB 状态断言 必须是 browser try block statement list 的直接表达式/],
    ['旧 token DB 读取早于响应', moveBefore('    const pendingAfterOldToken = accountState(email);', '    const oldTokenResult = await oldTokenResponse;'), /pendingAfterOldToken 必须在 oldTokenResult 真实响应后读取/],
    ['首次文件 600 断言不可达', mutate("assert.ok(firstOutbox.messages.every((message) => message.mode === '600'), 'outbox 邮件权限必须全部为 600');", "if (false) assert.ok(firstOutbox.messages.every((message) => message.mode === '600'), 'outbox 邮件权限必须全部为 600');"), /firstOutbox 文件 600 断言 必须是 browser try block statement list 的直接表达式/],
    ['重发文件 600 证据仅为字符串', mutate("assert.ok(secondOutbox.messages.every((message) => message.mode === '600'), '重发后 outbox 邮件权限必须全部为 600');", 'void "secondOutbox message.mode === 600";'), /必须恰好提供 secondOutbox 文件 600 断言/],
    ['最终文件 600 callback 无参数', mutate('finalOutbox.messages.every((message) => message.mode', 'finalOutbox.messages.every(() => true && message.mode'), /finalOutbox 文件 mode callback 必须接收一个标识符参数/],
    ['重发 outbox 读取早于响应', moveBefore('    const secondOutbox = readOutbox();', '    const resendResult = await resendResponse;'), /secondOutbox 必须在 resendResult 真实响应后读取/],
    ['首次 outbox 700 断言藏在环境分支', mutate("assert.equal(firstOutbox.directoryMode, '700');", "if (process.env.NEVER_SET) assert.equal(firstOutbox.directoryMode, '700');"), /firstOutbox 700 断言 必须是 browser try block statement list 的直接表达式/],
    ['重发邮件数量错误', mutate("assert.equal(resendMessages.length, 1, '重发必须只新增一封验证邮件');", "assert.equal(resendMessages.length, 2, '重发必须只新增一封验证邮件');")],
    ['token 未换代', mutate("assert.notEqual(newToken, token, '重发必须生成新 token');", "assert.equal(newToken, token, '重发必须生成新 token');")],
    ['等待窗口不足', mutate('61_000', '1_000')],
    ['重放 422 断言藏在环境分支', mutate('assert.equal(replay.status(), 422);', 'if (process.env.NEVER_SET) assert.equal(replay.status(), 422);'), /重放 422 断言 必须是 browser try block statement list 的直接表达式/],
    ['重放响应后提前 return', mutate('const replay = await replayResponse;', 'const replay = await replayResponse;\n    return;'), /不得在最终证据序列前 return、throw 或 process\.exit/],
    ['旧 token Problem code 错误', mutate("assert.equal((await oldTokenResult.json()).code, 'VALIDATION_FAILED');", "assert.equal((await oldTokenResult.json()).code, 'RATE_LIMITED');")],
    ['重放 Problem code 错误', mutate("assert.equal((await replay.json()).code, 'VALIDATION_FAILED');", "assert.equal((await replay.json()).code, 'RATE_LIMITED');")],
    ['吞掉旧 token 422 浏览器诊断', mutate("assert.notEqual(oldTokenConsoleErrorIndex, -1, '必须采集绑定到旧 token 响应 URL 的 Chromium 422 诊断');", "assert.equal(oldTokenConsoleErrorIndex, -1, '必须采集绑定到旧 token 响应 URL 的 Chromium 422 诊断');")],
    ['旧 token console 文本加后缀', mutate('the server responded with a status of ${oldTokenResult.status()} ()`', 'the server responded with a status of ${oldTokenResult.status()} () extra`'), /旧 token 422 console 文本必须精确绑定真实响应 status/],
    ['重放 console 断言不可达', mutate("assert.notEqual(replayConsoleErrorIndex, -1, '必须采集绑定到重放响应 URL 的 Chromium 422 诊断');", "if (false) assert.notEqual(replayConsoleErrorIndex, -1, '必须采集绑定到重放响应 URL 的 Chromium 422 诊断');"), /重放 422 console URL 绑定断言 必须是 browser try block statement list 的直接表达式/],
    ['重放 console findIndex callback 无参数', mutate('consoleErrors.findIndex((entry) => entry.url === replay.url())', 'consoleErrors.findIndex(() => true)'), /console findIndex callback 必须接收一个标识符参数/],
    ['重复注册通用回执断言不可达', mutate('assert.match(duplicateMessages[0].body, /Your request was received\\./);', 'if (false) assert.match(duplicateMessages[0].body, /Your request was received\\./);'), /重复注册通用回执断言 必须是 browser try block statement list 的直接表达式/],
    ['API 动作顺序错误', mutate("['/api/v1/accounts/verification/resend', 200]", "['/api/v1/accounts/verification/resend', 201]")],
    ['日志来自非 app 服务', mutate("'logs', '--no-color', 'app'", "'logs', '--no-color', 'postgres'")],
    ['日志密码断言不可达', mutate("assert.ok(!appLogs.includes(password), 'app 日志不得包含测试密码');", "if (false) assert.ok(!appLogs.includes(password), 'app 日志不得包含测试密码');"), /app 日志密码断言 必须是 browser try block statement list 的直接表达式/],
    ['日志首次 token 断言仅为字符串', mutate("assert.ok(!appLogs.includes(token), 'app 日志不得包含首次验证 token');", 'void "appLogs without token";'), /必须恰好提供 app 日志 token 断言/],
    ['日志重发 token 断言不可达', mutate("assert.ok(!appLogs.includes(newToken), 'app 日志不得包含重发验证 token');", "if (false) assert.ok(!appLogs.includes(newToken), 'app 日志不得包含重发验证 token');"), /app 日志重发 token 断言 必须是 browser try block statement list 的直接表达式/],
    ['最终外联断言不可达', mutate('assert.deepEqual(externalRequests, []);', 'if (false) assert.deepEqual(externalRequests, []);')],
    ['最终 console 断言不可达', mutate('assert.deepEqual(consoleErrors, []);', 'if (false) assert.deepEqual(consoleErrors, []);')],
    ['CSRF find callback 无参数', mutate('cookies.find((cookie) =>', 'cookies.find(() =>'), /CSRF cookie find callback 必须接收一个标识符参数/],
    ['cookie log every callback 无参数', mutate('cookies.every((cookie) => !appLogs.includes(cookie.value))', 'cookies.every(() => true)'), /cookie every callback 必须接收一个标识符参数/],
    ['缺 finally close', mutate('await browser.close();', 'void browser;')],
  ]) {
    assert.throws(
      () => assertId01BrowserSmokeAllowedSurface(source),
      expectedMessage ? { name: 'AssertionError', message: expectedMessage } : assert.AssertionError,
      `ID-01 browser validator 必须拒绝 ${name}`,
    );
  }
});

test('客户端源码 validator 采用空壳能力允许面', () => {
  const validSources = {
    'App.vue': `<script setup lang="ts">
import { ref } from 'vue';
const activeRole = ref('host');
</script>
<template>
  <main class="shell">
    <h1>TTSync</h1>
    <nav role="tablist">
      <button role="tab" type="button" @click="activeRole = 'host'">主持人视图</button>
      <button role="tab" type="button" @click="activeRole = 'participant'">参与者视图</button>
      <button role="tab" type="button" @click="activeRole = 'spectator'">观众视图</button>
    </nav>
    <p>{{ activeRole }}</p>
  </main>
</template>`,
    'main.ts': `import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
createApp(App).mount('#app');`,
    'style.css': `.shell { color: #172033; }`,
  };
  assert.doesNotThrow(() => assertClientAllowedSurface(validSources));
  const id01Sources = {
    ...validSources,
    'App.vue': `<script setup lang="ts">
import { onMounted, ref } from 'vue';
const activeRole = ref('host');
const email = ref('');
const password = ref('');
const registerMessage = ref('');
const resendMessage = ref('');
const verificationMessage = ref('');
const submitting = ref(false);
const csrf = () => document.cookie.split('; ').find((value) => value.startsWith('__Host-ttsync-csrf='))?.slice('__Host-ttsync-csrf='.length) ?? '';
async function post(path: '/api/v1/accounts' | '/api/v1/accounts/verification/resend' | '/api/v1/accounts/verification', body: object) {
  return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify(body) });
}
async function register() { await post('/api/v1/accounts', { email: email.value, password: password.value }); }
async function resend() { await post('/api/v1/accounts/verification/resend', { email: email.value }); }
onMounted(async () => {
  const token = new URLSearchParams(location.search).get('token');
  if (!token) return;
  history.replaceState(null, '', '/verify');
  await post('/api/v1/accounts/verification', { token });
});
</script>
<template>
  <main class="shell">
    <nav role="tablist">
      <button role="tab" type="button" @click="activeRole = 'host'">主持人视图</button>
      <button role="tab" type="button" @click="activeRole = 'participant'">参与者视图</button>
      <button role="tab" type="button" @click="activeRole = 'spectator'">观众视图</button>
    </nav>
    <form aria-label="创建账号" @submit.prevent="register">
      <label for="register-email">邮箱</label><input id="register-email" v-model="email" type="email">
      <label for="register-password">密码</label><input id="register-password" v-model="password" type="password">
      <button type="submit" :disabled="submitting">注册</button>
    </form>
    <form aria-label="重发验证邮件" @submit.prevent="resend">
      <button type="submit" :disabled="submitting">重发验证邮件</button>
    </form>
    <p role="status" aria-live="polite">{{ registerMessage }}{{ resendMessage }}{{ verificationMessage }}</p>
  </main>
</template>`,
  };
  assert.doesNotThrow(() => assertClientAllowedSurface(id01Sources, { requireId01: true }), 'ID-01 合法客户端 fixture 必须通过');
  assert.throws(
    () => assertClientAllowedSurface(validSources, { requireId01: true }),
    { name: 'AssertionError', message: /真实客户端必须保留 ID-01/ },
    '删除整个 ID-01 客户端能力不得回退为 B-01 空壳校验',
  );
  assert.throws(
    () => assertClientAllowedSurface({
      ...id01Sources,
      'App.vue': id01Sources['App.vue'].replace('import { onMounted, ref }', 'import { ref }'),
    }, { requireId01: true }),
    { name: 'AssertionError', message: /真实客户端必须保留 ID-01/ },
    '删除 onMounted 能力标记不得让真实客户端静默降级为 B-01',
  );
  for (const [name, app, expectedMessage] of [
    ['动态/其他 API URL', id01Sources['App.vue'].replace('fetch(path,', "fetch('/api/v1/teams',")],
    ['绝对 URL', id01Sources['App.vue'].replace('fetch(path,', "fetch('https://example.invalid/api',")],
    ['第二个 fetch', id01Sources['App.vue'].replace('async function register()', "fetch('/api/v1/accounts');\nasync function register()")],
    ['fetch 别名调用', id01Sources['App.vue'].replace('async function register()', "const f = fetch;\nf('/api/v1/teams');\nasync function register()"), /原生 fetch 不得被别名/],
    ['fetch.bind 别名调用', id01Sources['App.vue'].replace('async function register()', "const f = fetch.bind(null);\nf('/api/v1/teams');\nasync function register()"), /原生 fetch 不得被别名/],
    ['fetch 别名动态绝对 URL', id01Sources['App.vue'].replace('async function register()', "const f = fetch;\nconst target = 'https:' + '/' + '/example.invalid/api';\nf(target);\nasync function register()"), /原生 fetch 不得被别名/],
    ['post helper 别名调用', id01Sources['App.vue'].replace('async function register()', "const extraPost = post;\nextraPost('/api/v1/teams' as any, {});\nasync function register()"), /post helper 不得被别名/],
    ['post helper bind 调用', id01Sources['App.vue'].replace('async function register()', "const extraPost = post.bind(null);\nextraPost('/api/v1/teams' as any, {});\nasync function register()"), /post helper 不得被别名/],
    ['非 POST', id01Sources['App.vue'].replace("method: 'POST'", "method: 'GET'")],
    ['非 same-origin credentials', id01Sources['App.vue'].replace("credentials: 'same-origin'", "credentials: 'include'")],
    ['CSRF header 非 cookie 值', id01Sources['App.vue'].replace("'X-CSRF-Token': csrf()", "'X-CSRF-Token': ''")],
    ['body 非原 payload', id01Sources['App.vue'].replace('JSON.stringify(body)', 'JSON.stringify({})')],
    ['XHR', id01Sources['App.vue'].replace('async function register()', 'new XMLHttpRequest();\nasync function register()')],
    ['WebSocket', id01Sources['App.vue'].replace('async function register()', "new WebSocket('wss://example.invalid');\nasync function register()")],
    ['cookie 写入', id01Sources['App.vue'].replace('async function register()', "document.cookie = 'x=y';\nasync function register()")],
    ['document 别名写 cookie', id01Sources['App.vue'].replace('async function register()', "const doc = document;\ndoc.cookie = 'x=y';\nasync function register()"), /document 不得被别名、写入/],
    ['document 其他能力', id01Sources['App.vue'].replace('async function register()', 'document.body;\nasync function register()')],
    ['location 其他能力', id01Sources['App.vue'].replace('async function register()', 'location.href;\nasync function register()')],
    ['history 其他能力', id01Sources['App.vue'].replace('async function register()', 'history.back();\nasync function register()')],
    ['storage', id01Sources['App.vue'].replace('async function register()', "localStorage.setItem('email', email.value);\nasync function register()")],
    ['验证页未清除 query', id01Sources['App.vue'].replace("history.replaceState(null, '', '/verify');", '')],
    ['模板 submit 发网', id01Sources['App.vue'].replace('@submit.prevent="register"', '@submit.prevent="fetch(\'/api/v1/accounts\')"')],
    ['模板插值发网', id01Sources['App.vue'].replace('{{ registerMessage }}', "{{ register() }}{{ registerMessage }}")],
    ['模板任意调用', id01Sources['App.vue'].replace('async function register()', 'function hiddenNetwork() { return true; }\nasync function register()').replace('<main class="shell">', '<main class="shell" v-if="hiddenNetwork()">'), /template 表达式不在精确允许面：hiddenNetwork\(\)/],
  ]) {
    assert.throws(
      () => assertClientAllowedSurface({ ...id01Sources, 'App.vue': app }),
      expectedMessage ? { name: 'AssertionError', message: expectedMessage } : assert.AssertionError,
      `ID-01 客户端 validator 必须拒绝 ${name}`,
    );
  }
  for (const [name, sources] of [
    ['sendBeacon', { ...validSources, 'App.vue': validSources['App.vue'].replace("const activeRole = ref('host');", "const activeRole = ref('host');\nnavigator.sendBeacon('/audit');") }],
    ['任意网络 Web API', { ...validSources, 'App.vue': validSources['App.vue'].replace("const activeRole = ref('host');", "const activeRole = ref('host');\nfetch('/api/team');") }],
    ['持久化 Web API', { ...validSources, 'App.vue': validSources['App.vue'].replace("const activeRole = ref('host');", "const activeRole = ref('host');\nlocalStorage.setItem('role', 'host');") }],
    ['模板外链资源', { ...validSources, 'App.vue': validSources['App.vue'].replace('<h1>TTSync</h1>', '<h1>TTSync</h1><img src="https://example.invalid/a.png">') }],
    ['额外源文件', { ...validSources, 'api.ts': 'export {};' }],
  ]) {
    assert.throws(() => assertClientAllowedSurface(sources), assert.AssertionError, `客户端 validator 必须拒绝 ${name}`);
  }
});

test('客户端模板表达式 validator 仅允许三角色本地切换', () => {
  const validSources = {
    'App.vue': `<script setup lang="ts">
import { ref } from 'vue';
const activeRole = ref('host');
</script>
<template>
  <main class="shell">
    <nav role="tablist">
      <button role="tab" type="button" @click="activeRole = 'host'">主持人视图</button>
      <button role="tab" type="button" @click="activeRole = 'participant'">参与者视图</button>
      <button role="tab" type="button" @click="activeRole = 'spectator'">观众视图</button>
    </nav>
    <p>{{ activeRole }}</p>
  </main>
</template>`,
    'main.ts': `import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
createApp(App).mount('#app');`,
    'style.css': '.shell { color: #172033; }',
  };
  assert.doesNotThrow(() => assertClientAllowedSurface(validSources));
  for (const [name, source] of [
    ['@click sendBeacon', validSources['App.vue'].replace("activeRole = 'host'", "navigator.sendBeacon('/audit')")],
    ['@click location.assign', validSources['App.vue'].replace("activeRole = 'participant'", "location.assign('https://example.test')")],
    ['重复 @click sendBeacon', validSources['App.vue'].replace("@click=\"activeRole = 'host'\"", "@click=\"activeRole = 'host'\" @click=\"navigator.sendBeacon('/audit')\"")],
    ['重复 @click location.assign', validSources['App.vue'].replace("@click=\"activeRole = 'participant'\"", "@click=\"activeRole = 'participant'\" @click=\"location.assign('https://example.test')\"")],
  ]) {
    assert.throws(
      () => assertClientAllowedSurface({ ...validSources, 'App.vue': source }),
      assert.AssertionError,
      `客户端模板表达式 validator 必须拒绝 ${name}`,
    );
  }
});

test('B-01 Compose 与 Caddy 只暴露三容器 HTTPS 运行面', () => {
  const composePath = requireFile('deployments/compose.yaml');
  const compose = parse(readFileSync(composePath, 'utf8'));
  assert.deepEqual(Object.keys(compose.services ?? {}).sort(), ['app', 'caddy', 'postgres'], 'Compose service 必须严格为 app,caddy,postgres');
  assert.equal(
    compose.services?.app?.environment?.PUBLIC_ORIGIN,
    '${TTSYNC_PUBLIC_ORIGIN:-https://localhost:8443}',
    'app PUBLIC_ORIGIN 必须来自 TTSYNC_PUBLIC_ORIGIN 且默认匹配本地 Caddy HTTPS',
  );
  assert.equal(compose.services?.app?.environment?.MAIL_OUTBOX_DIR, '${TTSYNC_MAIL_OUTBOX_DIR:-}', 'Compose 必须显式透传测试 outbox');
  for (const name of ['ADDR', 'FROM', 'USERNAME', 'PASSWORD']) {
    assert.equal(compose.services?.app?.environment?.[`SMTP_${name}`], `\${TTSYNC_SMTP_${name}:-}`, `Compose 必须透传 SMTP_${name}`);
  }
  const caddySource = readFileSync(requireFile('deployments/Caddyfile'), 'utf8');
  assert.match(caddySource, /tls\s+internal/, 'Caddy 必须是唯一的本地 HTTPS 入口');
  assert.match(caddySource, /reverse_proxy\s+app:8080/, 'Caddy 只能反向代理应用服务');
});

test('Compose smoke 复用同一 project 运行 ID-01 并恢复环境', () => {
  const smoke = readFileSync(requireFile('scripts/smoke-b01.ps1'), 'utf8');
  for (const savedName of ['previousPublicOrigin', 'previousId01ComposeProject', 'previousId01ComposeFile', 'previousMailOutboxDir', 'previousSmtpAddr', 'previousSmtpFrom', 'previousSmtpUsername', 'previousSmtpPassword']) {
    assert.match(smoke, new RegExp(`\\$${savedName}\\s*=\\s*\\$env:`), `smoke 必须保存 ${savedName} 对应环境`);
  }
  assert.match(smoke, /\$env:TTSYNC_PUBLIC_ORIGIN\s*=\s*\$env:B01_BASE_URL/, 'PUBLIC_ORIGIN 必须精确复用 B01_BASE_URL');
  assert.match(smoke, /\$env:ID01_COMPOSE_PROJECT\s*=\s*\$script:projectName/, 'ID-01 必须复用同一随机 Compose project');
  assert.match(smoke, /\$env:ID01_COMPOSE_FILE\s*=\s*\$script:composeFile/, 'ID-01 必须复用同一 Compose 文件');
  assert.match(smoke, /\$env:TTSYNC_MAIL_OUTBOX_DIR\s*=\s*['"]\/tmp\/ttsync-outbox['"]/, 'smoke 必须显式启用测试 outbox');
  for (const name of ['ADDR', 'FROM', 'USERNAME', 'PASSWORD']) {
    assert.match(smoke, new RegExp(`\\$env:TTSYNC_SMTP_${name}\\s*=\\s*['\"]['\"]`), `smoke 必须清空宿主 SMTP_${name}`);
  }
  const b01Browser = smoke.lastIndexOf("@('--test', 'test/b01-browser-smoke.mjs')");
  const id01Browser = smoke.indexOf("@('--test', 'test/id01-browser-smoke.mjs')");
  assert.ok(b01Browser >= 0 && id01Browser > b01Browser, 'ID-01 browser 必须在最终 B-01 browser 通过后单独运行');
  assert.match(smoke, /\$env:TTSYNC_PUBLIC_ORIGIN\s*=\s*\$previousPublicOrigin/, 'smoke finally 必须恢复 TTSYNC_PUBLIC_ORIGIN');
  assert.match(smoke, /\$env:ID01_COMPOSE_PROJECT\s*=\s*\$previousId01ComposeProject/, 'smoke finally 必须恢复 ID01_COMPOSE_PROJECT');
  assert.match(smoke, /\$env:ID01_COMPOSE_FILE\s*=\s*\$previousId01ComposeFile/, 'smoke finally 必须恢复 ID01_COMPOSE_FILE');
  assert.match(smoke, /\$env:TTSYNC_MAIL_OUTBOX_DIR\s*=\s*\$previousMailOutboxDir/, 'smoke finally 必须恢复 outbox 环境');
  for (const [name, saved] of [['ADDR', 'Addr'], ['FROM', 'From'], ['USERNAME', 'Username'], ['PASSWORD', 'Password']]) {
    assert.match(smoke, new RegExp(`\\$env:TTSYNC_SMTP_${name}\\s*=\\s*\\$previousSmtp${saved}`), `smoke finally 必须恢复 SMTP_${name}`);
  }
});

test('Task 5 镜像、浏览器与 Caddy 验收可重现且封闭绕过面', () => {
  const dockerfile = readFileSync(requireFile('deployments/Dockerfile'), 'utf8');
  const fromLines = dockerfile.match(/^FROM\s+.+$/gm) ?? [];
  assert.equal(fromLines.length, 3, 'Dockerfile 必须保持三阶段构建');
  for (const fromLine of fromLines) {
    assert.match(fromLine, /^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?$/, `Dockerfile 基础镜像必须固定 multiarch digest：${fromLine}`);
  }
  assert.doesNotMatch(dockerfile, /\bapk\s+add\b/, 'runtime 不得在构建时下载漂移包');
  assert.match(
    dockerfile,
    /^FROM\s+golang:1\.25-alpine@sha256:56961d79ea8129efddcc0b8643fd8a5416b4e6228cfd477e3fd61deb2672c587\s+AS\s+go-build$/m,
    'Go builder 必须与计划一致并固定官方 Go 1.25 multiarch index digest',
  );
  assert.match(dockerfile, /^RUN\s+addgroup\s+-S\s+ttsync\s+&&\s+adduser\s+-S\s+-D\s+-H\s+-s\s+\/sbin\/nologin\s+-G\s+ttsync\s+ttsync$/m, 'runtime 必须创建专用无登录用户');
  assert.match(dockerfile, /^USER\s+ttsync:ttsync$/m, 'runtime 必须以专用非 root 用户运行');

  const compose = parse(readFileSync(requireFile('deployments/compose.yaml'), 'utf8'));
  for (const serviceName of ['postgres', 'caddy']) {
    assert.match(compose.services?.[serviceName]?.image ?? '', /^[^@\s]+@sha256:[a-f0-9]{64}$/, `${serviceName} 镜像必须固定 multiarch digest`);
  }
  const testGoSource = readFileSync(requireFile('scripts/test-go.ps1'), 'utf8');
  const testGoPostgresImages = testGoSource.match(/postgres:17-alpine@sha256:[a-f0-9]{64}/g) ?? [];
  assert.deepEqual(testGoPostgresImages, [compose.services.postgres.image], 'test:go 必须精确复用 Compose 的完整 PostgreSQL tag 与 digest');
  const caddyHealth = JSON.stringify(compose.services?.caddy?.healthcheck?.test ?? []);
  assert.match(caddyHealth, /https:\/\/localhost\/health\/live/, 'Caddy healthcheck 必须经真实 HTTPS reverse_proxy 探测 liveness');
  assert.doesNotMatch(caddyHealth, /:2019/, 'Caddy healthcheck 不得仅探测 admin 端点');

  const readme = readFileSync(requireFile('README.md'), 'utf8');
  const clientPackage = JSON.parse(readFileSync(requireFile('clients/web/package.json'), 'utf8'));
  assert.match(readme, /Node\.js `\^20\.19\.0 \|\| >=22\.12\.0`/, 'README Node 前置必须精确匹配客户端 engines');
  assert.equal(clientPackage.engines?.node, '^20.19.0 || >=22.12.0', '客户端 Node engines 必须保持锁定');
  for (const command of ['npm run contracts:check', 'npm run db:migrate:test', 'npm run test:go', 'npm run smoke:b01']) {
    assert.match(readme, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README 必须说明 ${command}`);
  }
  const npmCiPosition = readme.indexOf('npm ci');
  const playwrightInstallPosition = readme.indexOf('npx --no-install playwright install chromium');
  assert.ok(npmCiPosition >= 0 && playwrightInstallPosition > npmCiPosition, 'README 必须先 npm ci，再以 --no-install 安装 Chromium');

  const browserSmoke = readFileSync(requireFile('test/b01-browser-smoke.mjs'), 'utf8');
  assert.match(browserSmoke, /from 'node:test'/, 'browser smoke 必须使用 node:test 显式 skip');
  assert.match(browserSmoke, /skip:\s*process\.env\.B01_RUN_BROWSER_SMOKE\s*!==\s*'1'/, 'browser smoke 必须由 node:test skip option 表达未启用');
  assert.doesNotMatch(browserSmoke, /process\.exit\s*\(/, 'browser smoke 不得中途 process.exit');
  assert.match(browserSmoke, /const baseOrigin = new URL\(baseUrl\)\.origin;/, 'browser smoke 必须导出基准 origin');
  const assertStrictBrowserOrigin = (source) => {
    assert.match(source, /new URL\(request\.url\(\)\)\.origin !== baseOrigin/, 'browser smoke 必须严格比较 URL origin');
    assert.doesNotMatch(source, /request\.url\(\)\.startsWith/, 'browser smoke 不得以共享前缀判断同源');
  };
  assertStrictBrowserOrigin(browserSmoke);
  assert.match(browserSmoke, /try\s*\{[\s\S]*\}\s*finally\s*\{\s*await browser\.close\(\);\s*\}/, 'browser launch 后必须由 finally 关闭');

  const baseOrigin = new URL('https://localhost:8443').origin;
  assert.notEqual(new URL('https://localhost.evil.test/path').origin, new URL('https://localhost').origin, '共享前缀恶意主机必须被判为外联');
  assert.notEqual(new URL('https://localhost:8443@evil.test/path').origin, baseOrigin, 'userinfo 恶意 URL 必须被判为外联');
  for (const [name, source] of [
    ['共享前缀 startsWith', browserSmoke.replace('new URL(request.url()).origin !== baseOrigin', 'request.url().startsWith(baseUrl)')],
    ['userinfo startsWith', browserSmoke.replace('new URL(request.url()).origin !== baseOrigin', "request.url().startsWith('https://localhost:8443@evil.test')")],
  ]) {
    assert.throws(() => assertStrictBrowserOrigin(source), assert.AssertionError, `严格 origin validator 必须拒绝 ${name}`);
  }
});

test('Go 模块版本与 B-01 计划一致', () => {
  assert.match(readFileSync(requireFile('go.mod'), 'utf8'), /^go 1\.25(?:\.0)?$/m, 'go.mod 必须声明 Go 1.25');
});

test('sqlc generation 在隔离目录生成并比较完整文件树', () => {
  const source = readFileSync(requireFile('scripts/generate-sqlc.ps1'), 'utf8');
  assert.doesNotMatch(source, /git\s+diff/, 'sqlc drift 不得依赖忽略 untracked 文件的 git diff');
  assert.match(source, /Copy-Item[\s\S]+db[\\/]sqlc\.yaml/, 'sqlc 必须复制最小配置到隔离目录');
  assert.match(source, /Copy-Item[\s\S]+db[\\/]queries/, 'sqlc 必须复制查询输入到隔离目录');
  assert.match(source, /Copy-Item[\s\S]+db[\\/]migrations/, 'sqlc 必须复制 schema 输入到隔离目录');
  assert.match(source, /assert-generated-tree\.ps1/, 'sqlc 必须比较隔离生成树与已提交生成树');
});

test('browser smoke 未启用时由 node:test 显式报告 skipped', () => {
  const environment = { ...process.env };
  delete environment.B01_RUN_BROWSER_SMOKE;
  delete environment.NODE_TEST_CONTEXT;
  const result = execFileSync(process.execPath, ['--test', 'test/b01-browser-smoke.mjs'], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
  });
  assert.match(result, /# skipped 1\b/, 'browser smoke 必须显式计入 skipped');
  assert.doesNotMatch(result, /# pass 1\b/, 'browser smoke 未启用时不得伪报普通 PASS');

  const id01Result = execFileSync(process.execPath, ['--test', 'test/id01-browser-smoke.mjs'], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
  });
  assert.match(id01Result, /# skipped 1\b/, 'ID-01 browser smoke 必须显式计入 skipped');
  assert.doesNotMatch(id01Result, /# pass 1\b/, 'ID-01 browser smoke 未启用时不得伪报普通 PASS');
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
  const clientSourceDirectory = join(repositoryRoot, 'clients/web/src');
  const sourceFiles = filesUnder('clients/web/src').map((file) => relative(clientSourceDirectory, file)).sort();
  assert.deepEqual(sourceFiles, ['App.vue', 'main.ts', 'style.css'], 'B-01 客户端只允许空壳源文件');
  assertClientAllowedSurface(Object.fromEntries(sourceFiles.map((file) => [file, readFileSync(join(clientSourceDirectory, file), 'utf8')])), { requireId01: true });
  const clientPackage = JSON.parse(readFileSync(requireFile('clients/web/package.json'), 'utf8'));
  const allowedClientPackages = new Set(['vue', '@vitejs/plugin-vue', 'typescript', 'vite', 'vue-tsc']);
  const declaredClientPackages = [...Object.keys(clientPackage.dependencies ?? {}), ...Object.keys(clientPackage.devDependencies ?? {})];
  assert.ok(clientPackage.dependencies?.vue, 'B-01 客户端必须直接依赖 Vue');
  assert.deepEqual(
    declaredClientPackages.filter((packageName) => !allowedClientPackages.has(packageName)),
    [],
    'B-01 客户端依赖只允许 Vue 构建空壳所需包',
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
