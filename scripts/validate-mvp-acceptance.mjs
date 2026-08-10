import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const manifestUrl = new URL("../specs/mvp-acceptance/manifest.json", import.meta.url);
const schemaUrl = new URL("../specs/mvp-acceptance/schema.json", import.meta.url);

async function readJson(url, label) {
  let source;
  try {
    source = await readFile(url, "utf8");
  } catch (error) {
    throw new Error(`${label} 缺失: ${url.pathname}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON: ${error.message}`, { cause: error });
  }
}

function fail(message) {
  throw new Error(message);
}

function walk(value, visit, path = "$") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => walk(item, visit, `${path}.${key}`));
  }
}

function validate(schema, manifest) {
  walk(manifest, (value, path) => {
    if (typeof value !== "string") return;
    if (/(?:CURRENT_TIMESTAMP|Date\.now\(|new Date\(|\bnow\(\))/i.test(value)) fail(`[determinism:time] 禁止当前时间来源: ${path}`);
    if (/(?:process\.env|Deno\.env|import\.meta\.env)/i.test(value)) fail(`[determinism:env] 禁止环境来源: ${path}`);
    if (/(?:crypto\.randomUUID|Math\.random|randomBytes|randomInt)\s*\(/i.test(value)) fail(`[determinism:random] 禁止随机来源: ${path}`);
  });
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateStructure = ajv.compile(schema);
  if (!validateStructure(manifest)) fail(`[schema] ${ajv.errorsText(validateStructure.errors, { separator: "; " })}`);
  const aliases = [];
  for (const fixture of Object.values(manifest.fixtures)) {
    aliases.push(...fixture.aliases);
  }
  assert.equal(new Set(aliases).size, aliases.length, "夹具语义别名不得重复");

  const registries = {
    account: new Set(manifest.fixtures["F-I"].accounts.map(({ alias }) => alias)),
    member: new Set(manifest.fixtures["F-T"].members.map(({ alias }) => alias)),
    project: new Set(manifest.fixtures["F-T"].projects.map(({ alias }) => alias)),
    template: new Set(manifest.fixtures["F-T"].templates.map(({ alias }) => alias)),
    actor: new Set(manifest.fixtures["F-A"].actors.map(({ alias }) => alias)),
    command: new Set(manifest.fixtures["F-A"].commandExamples.map(({ alias }) => alias)),
    commandId: new Set(Object.keys(manifest.determinism.commandIds))
  };
  const resolve = (category, value, path) => {
    if (value !== null && !registries[category].has(value)) fail(`[reference:${category}] ${path} 引用了未知或错误类别别名 ${value}`);
  };
  manifest.fixtures["F-I"].sessions.forEach(({ account }, index) => resolve("account", account, `F-I.sessions[${index}].account`));
  manifest.fixtures["F-T"].members.forEach(({ account }, index) => resolve("account", account, `F-T.members[${index}].account`));
  manifest.fixtures["F-T"].projects.forEach(({ template }, index) => resolve("template", template, `F-T.projects[${index}].template`));
  resolve("project", manifest.fixtures["F-A"].room.project, "F-A.room.project");
  manifest.fixtures["F-A"].actors.forEach(({ member }, index) => {
    if (member !== undefined) resolve("member", member, `F-A.actors[${index}].member`);
  });
  manifest.fixtures["F-A"].cards.forEach(({ owner, claim }, index) => {
    resolve("member", owner, `F-A.cards[${index}].owner`);
    resolve("actor", claim, `F-A.cards[${index}].claim`);
  });
  manifest.fixtures["F-A"].commandExamples.forEach(({ actor, commandIdRef, replayOf }, index) => {
    resolve("actor", actor, `F-A.commandExamples[${index}].actor`);
    resolve("commandId", commandIdRef, `F-A.commandExamples[${index}].commandIdRef`);
    if (replayOf !== undefined) resolve("command", replayOf, `F-A.commandExamples[${index}].replayOf`);
  });

  const allStories = new Set();
  const fixtureIds = new Set(Object.keys(manifest.fixtures));
  const seenMvps = new Set();
  for (const mvp of manifest.mvps) {
    mvp.ownedStories.forEach((story) => {
      if (allStories.has(story)) fail(`[story-owner] 故事 ${story} 存在多个 owner`);
      allStories.add(story);
    });
    mvp.fixtures.forEach((id) => assert.ok(fixtureIds.has(id), `${mvp.id} 引用了未知夹具 ${id}`));
    mvp.prerequisites.forEach((id) => assert.ok(seenMvps.has(id), `${mvp.id} 的前置 ${id} 不存在或形成倒序依赖`));
    seenMvps.add(mvp.id);
  }
  assert.deepEqual([...allStories].sort((a, b) => a - b), Array.from({ length: 163 }, (_, index) => index + 1), "[story-owner] 故事 1..163 必须恰有一个 owner");
  manifest.mvps.forEach((mvp) => (mvp.relatedStories ?? []).forEach((story) => {
    assert.ok(allStories.has(story), `${mvp.id}.relatedStories 引用了无 owner 故事 ${story}`);
    assert.ok(!mvp.ownedStories.includes(story), `${mvp.id} 不得把 owner 关系重复声明为 related`);
  }));

  assert.equal(manifest.fixtures["F-I"].tokens[0].expiresAt, manifest.determinism.times.tokenValidUntil);
  assert.equal(manifest.fixtures["F-I"].tokens[1].expiresAt, manifest.determinism.times.tokenExpiredAt);
  assert.equal(manifest.fixtures["F-I"].tokens[2].expiresAt, manifest.determinism.times.tokenValidUntil);
  assert.equal(manifest.fixtures["F-A"].room.revision, manifest.determinism.revisions.initial);
  manifest.fixtures["F-A"].records.forEach(({ occurredAt }) => assert.equal(occurredAt, manifest.determinism.times.matchOccurredAt));
  const [successfulMove, stableRetry, noOp, fingerprintConflict] = manifest.fixtures["F-A"].commandExamples;
  assert.equal(successfulMove.commandIdRef, "successfulMove");
  assert.equal(stableRetry.commandIdRef, successfulMove.commandIdRef);
  assert.equal(stableRetry.requestFingerprint, successfulMove.requestFingerprint);
  assert.deepEqual(
    { expectedRevision: stableRetry.expectedRevision, resultRevision: stableRetry.resultRevision, changed: stableRetry.changed, replayOf: stableRetry.replayOf },
    { expectedRevision: successfulMove.expectedRevision, resultRevision: successfulMove.resultRevision, changed: successfulMove.changed, replayOf: "MOVE-SUCCESS" }
  );
  assert.deepEqual([noOp.commandIdRef, noOp.expectedRevision, noOp.resultRevision, noOp.changed], ["noOp", 41, 41, false]);
  assert.equal(fingerprintConflict.commandIdRef, successfulMove.commandIdRef);
  assert.notEqual(fingerprintConflict.requestFingerprint, successfulMove.requestFingerprint);
  assert.equal(fingerprintConflict.result, "stable-conflict");

  assert.equal(manifest.fixtures["F-F"].restoreSet.generatedAt, manifest.determinism.times.backupGenerationAt);
  const restoreSet = manifest.fixtures["F-F"].restoreSet;
  assert.deepEqual(restoreSet.manifestEntries, restoreSet.components.slice(0, 2).map(({ semanticName, sha256, bytes }) => ({ semanticName, sha256, bytes })));

  assert.ok(manifest.csvCases.some(({ value }) => /[\u3400-\u9fff]/u.test(value)), "CSV 必须覆盖中文");
  for (const prefix of ["=", "+", "-", "@"]) {
    assert.ok(manifest.csvCases.some(({ value, expectedEscaped }) => value.startsWith(prefix) && expectedEscaped.startsWith("'")), `CSV 缺少 ${prefix} 公式注入边界`);
  }
  const forbiddenKeys = /^(?:.*Id|.*_id|table|tableName|primaryKey|autoIncrementId|privateFunction)$/;
  const sensitiveKeys = /(?:password|secret|tokenValue|apiKey|privateKey|credential)$/i;
  const secretValue = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@|password\s*[:=]\s*(?!<TEST_ONLY>))/i;
  walk(manifest, (value, path) => {
    const key = path.split(".").at(-1);
    const semanticIdPath = /^\$(?:\.fixtures\.F-[ITAFO]\.id|\.mvps\[\d+\]\.id)$/.test(path);
    if ((key === "id" && !semanticIdPath) || forbiddenKeys.test(key)) fail(`禁止绑定实现主键或私有实现: ${path}`);
    if (sensitiveKeys.test(key) && value !== "<TEST_ONLY>") fail(`秘密字段只能使用测试占位符: ${path}`);
    if (typeof value === "string" && secretValue.test(value)) fail(`疑似真实秘密: ${path}`);
    if (typeof value === "string" && /\b(?:now|today|current_timestamp|auto_increment|serial|SELECT|INSERT|UPDATE|DELETE)\b/i.test(value)) fail(`禁止非确定时间或实现细节: ${path}`);
  });
}

function clone(value) {
  return structuredClone(value);
}

function expectRejected(schema, manifest, name, expectedRule, mutate) {
  const candidate = clone(manifest);
  mutate(candidate);
  assert.throws(() => validate(schema, candidate), expectedRule, `负例未命中预期规则: ${name}`);
}

const schema = await readJson(schemaUrl, "schema");
const manifest = await readJson(manifestUrl, "manifest");
validate(schema, manifest);

const rejectionCases = [
  ["F-F limits 禁止额外字段", /\[schema\]/, (value) => { value.fixtures["F-F"].limits.untrackedLimit = 1; }],
  ["F-F imageCase 必须完整", /\[schema\]/, (value) => { delete value.fixtures["F-F"].imageCases[0].expected; }],
  ["F-O environment 禁止额外字段", /\[schema\]/, (value) => { value.fixtures["F-O"].environment.untrackedService = true; }],
  ["MVP 必须按编号排序", /\[schema\]/, (value) => { [value.mvps[0], value.mvps[1]] = [value.mvps[1], value.mvps[0]]; }],
  ["图片类别必须使用固定枚举", /\[schema\]/, (value) => { value.fixtures["F-F"].imageCases[0].category = "future-image-category"; }],
  ...[
    ["合法 JPEG", 0],
    ["合法 PNG", 1],
    ["伪装图片", 2],
    ["动态图片", 3],
    ["尺寸超限图片", 6],
    ["像素超限图片", 7]
  ].flatMap(([categoryName, index]) => ["width", "height", "frames"].map((field) => [
    `${categoryName}必须包含 ${field}`,
    new RegExp(`\\[schema\\].*must have required property '${field}'`),
    (value) => { delete value.fixtures["F-F"].imageCases[index][field]; }
  ])),
  ["测试客户端上限由 schema 执行", /\[schema\]/, (value) => { value.fixtures["F-O"].clients.push("CLIENT-21"); }],
  ["重复故事 owner", /\[story-owner\]/, (value) => value.mvps[2].ownedStories.push(7)],
  ["未知 account 引用", /\[reference:account\]/, (value) => { value.fixtures["F-I"].sessions[0].account = "ACCOUNT-UNKNOWN"; }],
  ["account 错类引用", /\[reference:account\]/, (value) => { value.fixtures["F-T"].members[0].account = "G1"; }],
  ["未知 project 引用", /\[reference:project\]/, (value) => { value.fixtures["F-A"].room.project = "PROJECT-UNKNOWN"; }],
  ["project 错类引用", /\[reference:project\]/, (value) => { value.fixtures["F-A"].room.project = "TEMPLATE-V1"; }],
  ["未知 template 引用", /\[reference:template\]/, (value) => { value.fixtures["F-T"].projects[0].template = "TEMPLATE-UNKNOWN"; }],
  ["template 错类引用", /\[reference:template\]/, (value) => { value.fixtures["F-T"].projects[0].template = "G2"; }],
  ["未知 member 引用", /\[reference:member\]/, (value) => { value.fixtures["F-A"].actors[0].member = "MEMBER-UNKNOWN"; }],
  ["member 错类引用", /\[reference:member\]/, (value) => { value.fixtures["F-A"].cards[0].owner = "HOST-1"; }],
  ["未知 claim actor 引用", /\[reference:actor\]/, (value) => { value.fixtures["F-A"].cards[0].claim = "ACTOR-UNKNOWN"; }],
  ["claim actor 错类引用", /\[reference:actor\]/, (value) => { value.fixtures["F-A"].cards[0].claim = "M1"; }],
  ["未知 command actor 引用", /\[reference:actor\]/, (value) => { value.fixtures["F-A"].commandExamples[0].actor = "ACTOR-UNKNOWN"; }],
  ["command actor 错类引用", /\[reference:actor\]/, (value) => { value.fixtures["F-A"].commandExamples[0].actor = "M1"; }],
  ["未知 commandIdRef 引用", /\[reference:commandId\]/, (value) => { value.fixtures["F-A"].commandExamples[0].commandIdRef = "unknownCommandId"; }],
  ["commandIdRef 错类引用", /\[reference:commandId\]/, (value) => { value.fixtures["F-A"].commandExamples[0].commandIdRef = "MOVE-SUCCESS"; }],
  ["未知 replayOf 引用", /\[reference:command\]/, (value) => { value.fixtures["F-A"].commandExamples[1].replayOf = "COMMAND-UNKNOWN"; }],
  ["replayOf 错类引用", /\[reference:command\]/, (value) => { value.fixtures["F-A"].commandExamples[1].replayOf = "U1"; }],
  ["当前时间来源", /\[determinism:time\]/, (value) => { value.fixtures["F-A"].records[0].occurredAt = "CURRENT_TIMESTAMP"; }],
  ["环境来源", /\[determinism:env\]/, (value) => { value.fixtures["F-A"].commandExamples[0].requestFingerprint = "process.env.REQUEST_FINGERPRINT"; }],
  ["随机来源", /\[determinism:random\]/, (value) => { value.fixtures["F-A"].commandExamples[0].requestFingerprint = "crypto.randomUUID()"; }]
];
rejectionCases.forEach(([name, expectedRule, mutate]) => expectRejected(schema, manifest, name, expectedRule, mutate));
console.log(`MVP 验收 manifest 校验通过；${rejectionCases.length} 个定向负例均被预期规则拒绝。`);
