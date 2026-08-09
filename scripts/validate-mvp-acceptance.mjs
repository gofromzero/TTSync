import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

function validateSchema(rootSchema, schema, value, path = "$") {
  if (schema.$ref) {
    const target = schema.$ref.split("/").slice(1).reduce((current, segment) => current[segment.replaceAll("~1", "/").replaceAll("~0", "~")], rootSchema);
    assert.ok(target, `${path} 引用了不存在的 schema: ${schema.$ref}`);
    return validateSchema(rootSchema, target, value, path);
  }
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const, `${path} 不符合 const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} 不在 enum 中`);
  if (schema.type === "object") {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `${path} 必须是 object`);
    if (schema.minProperties !== undefined) assert.ok(Object.keys(value).length >= schema.minProperties, `${path} 属性不足`);
    (schema.required ?? []).forEach((key) => assert.ok(Object.hasOwn(value, key), `${path} 缺少 ${key}`));
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(rootSchema, schema.properties[key], item, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`${path} 不允许属性 ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchema(rootSchema, schema.additionalProperties, item, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${path} 必须是 array`);
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path} 元素不足`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${path} 元素过多`);
    if (schema.uniqueItems) assert.equal(new Set(value.map((item) => JSON.stringify(item))).size, value.length, `${path} 元素不得重复`);
    value.forEach((item, index) => validateSchema(rootSchema, schema.items, item, `${path}[${index}]`));
  } else if (schema.type === "string") {
    assert.equal(typeof value, "string", `${path} 必须是 string`);
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${path} 过短`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${path} 不匹配 pattern`);
    if (schema.format === "date-time") assert.ok(!Number.isNaN(Date.parse(value)) && /Z$/.test(value), `${path} 不是 UTC date-time`);
    if (schema.format === "uuid") assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `${path} 不是 UUID`);
  } else if (schema.type === "integer") {
    assert.ok(Number.isInteger(value), `${path} 必须是 integer`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path} 小于 minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path} 大于 maximum`);
  }
}

function validate(schema, manifest) {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://ttsync.test/specs/mvp-acceptance/schema.json");
  validateSchema(schema, schema, manifest);
  assert.equal(manifest.schemaVersion, "1.0.0");
  assert.equal(manifest.fixturePolicy?.semanticAliasesOnly, true);
  assert.equal(manifest.fixturePolicy?.containsRealSecrets, false);

  const expectedGroups = ["F-I", "F-T", "F-A", "F-F", "F-O"];
  assert.deepEqual(Object.keys(manifest.fixtures).sort(), [...expectedGroups].sort());
  const aliases = [];
  for (const [group, fixture] of Object.entries(manifest.fixtures)) {
    assert.equal(fixture.id, group);
    assert.ok(Array.isArray(fixture.aliases) && fixture.aliases.length > 0, `${group} 必须声明 aliases`);
    aliases.push(...fixture.aliases);
  }
  assert.equal(new Set(aliases).size, aliases.length, "夹具语义别名不得重复");
  aliases.forEach((alias) => assert.match(alias, /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/, `非法语义别名: ${alias}`));

  assert.deepEqual(manifest.fixtures["F-I"].accounts.map(({ alias, verification }) => [alias, verification]), [["U0", "pending"], ["U1", "verified"], ["U2", "verified"]]);
  assert.deepEqual(manifest.fixtures["F-I"].sessions.map(({ alias, state }) => [alias, state]), [["SESSION-U1-A", "active"], ["SESSION-U1-B", "active"]]);
  assert.deepEqual(manifest.fixtures["F-I"].tokens.map(({ alias, state }) => [alias, state]), [["TOKEN-VALID", "valid"], ["TOKEN-EXPIRED", "expired"], ["TOKEN-REVOKED", "revoked"]]);
  assert.deepEqual(manifest.fixtures["F-T"].members.map(({ alias, role, state }) => [alias, role, state]), [
    ["M1", "administrator", "enabled"], ["M2", "administrator", "enabled"], ["MEMBER-REGULAR", "member", "enabled"],
    ["MEMBER-DISABLED", "member", "disabled"], ["MEMBER-INVITED", "member", "invited"]
  ]);
  assert.deepEqual(manifest.fixtures["F-T"].projects.map(({ alias, state }) => [alias, state]), [["G1", "enabled"], ["G2", "disabled"]]);
  assert.deepEqual(manifest.fixtures["F-T"].templates.map(({ alias, version }) => [alias, version]), [["TEMPLATE-V1", 1], ["TEMPLATE-V2", 2]]);
  assert.deepEqual(manifest.fixtures["F-A"].actors.map(({ alias, kind }) => [alias, kind]), [["HOST-1", "host"], ["PARTICIPANT-1", "participant"], ["PARTICIPANT-2", "participant"], ["SPECTATOR-1", "spectator"]]);
  assert.deepEqual(manifest.fixtures["F-A"].cards.map(({ alias, origin }) => [alias, origin]), [["CARD-MEMBER", "member"], ["CARD-GUEST", "guest"]]);
  assert.deepEqual(manifest.fixtures["F-A"].teams.map(({ alias, capacity }) => [alias, capacity]), [["TEAM-CAPACITY-1", 1], ["TEAM-CAPACITY-2", 2]]);
  assert.deepEqual(manifest.fixtures["F-A"].records.map(({ alias, state }) => [alias, state]), [["RECORD-DRAFT", "draft"], ["RECORD-CONFIRMED", "confirmed"], ["RECORD-VOIDED", "voided"]]);

  const expectedMvpIds = Array.from({ length: 12 }, (_, index) => `MVP-${String(index + 1).padStart(2, "0")}`);
  assert.deepEqual(manifest.mvps.map(({ id }) => id), expectedMvpIds, "必须完整且有序地声明 MVP-01..12");
  const allStories = new Set();
  const fixtureIds = new Set(expectedGroups);
  const seenMvps = new Set();
  for (const mvp of manifest.mvps) {
    for (const key of ["positive", "authorizationNegative", "concurrencyOrFailureNegative", "authoritativeSeam"]) {
      assert.ok(typeof mvp[key] === "string" && mvp[key].trim(), `${mvp.id}.${key} 不得为空`);
    }
    assert.ok(Array.isArray(mvp.stories) && mvp.stories.length > 0, `${mvp.id} 必须映射故事`);
    mvp.stories.forEach((story) => {
      assert.ok(Number.isInteger(story) && story >= 1 && story <= 163, `${mvp.id} 包含非法故事号`);
      allStories.add(story);
    });
    mvp.fixtures.forEach((id) => assert.ok(fixtureIds.has(id), `${mvp.id} 引用了未知夹具 ${id}`));
    mvp.prerequisites.forEach((id) => assert.ok(seenMvps.has(id), `${mvp.id} 的前置 ${id} 不存在或形成倒序依赖`));
    seenMvps.add(mvp.id);
  }
  assert.deepEqual([...allStories].sort((a, b) => a - b), Array.from({ length: 163 }, (_, index) => index + 1), "故事 1..163 必须全部覆盖");

  Object.entries(manifest.determinism.times).forEach(([name, value]) => {
    assert.match(value, /^2026-01-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `时间 ${name} 必须是固定 UTC RFC3339 值`);
  });
  assert.deepEqual(manifest.determinism.revisions, { initial: 40, changed: 41, unchanged: 41, stale: 40 });
  Object.values(manifest.determinism.commandIds).forEach((value) => {
    assert.match(value, /^00000000-0000-4000-8000-[0-9a-f]{12}$/, `commandId 必须是固定 UUID: ${value}`);
  });
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

  const fileCategories = new Set(manifest.fixtures["F-F"].imageCases.map(({ category }) => category));
  ["valid-jpeg", "valid-png", "disguised", "animated", "corrupt", "over-byte-limit", "over-dimension-limit", "over-pixel-limit"].forEach((category) => {
    assert.ok(fileCategories.has(category), `F-F 缺少图片类别 ${category}`);
  });
  const assetStates = new Set(manifest.fixtures["F-F"].assets.map(({ state }) => state));
  ["referenced", "zero-reference"].forEach((state) => assert.ok(assetStates.has(state), `F-F 缺少资产状态 ${state}`));
  assert.equal(manifest.fixtures["F-F"].restoreSet.expected.digestVerification, "all-match");
  assert.equal(manifest.fixtures["F-F"].restoreSet.expected.missingFiles, 0);
  assert.equal(manifest.fixtures["F-F"].restoreSet.generatedAt, manifest.determinism.times.backupGenerationAt);
  const restoreSet = manifest.fixtures["F-F"].restoreSet;
  assert.deepEqual(restoreSet.components.map(({ semanticName }) => semanticName), ["database-dump", "avatar-archive", "recovery-manifest"]);
  restoreSet.components.forEach(({ sha256, bytes }) => {
    assert.match(sha256, /^[0-9a-f]{64}$/, "恢复集组件必须固定 SHA-256 摘要");
    assert.ok(Number.isInteger(bytes) && bytes > 0, "恢复集组件必须固定正整数字节数");
  });
  assert.deepEqual(restoreSet.manifestEntries, restoreSet.components.slice(0, 2).map(({ semanticName, sha256, bytes }) => ({ semanticName, sha256, bytes })));
  assert.deepEqual(restoreSet.expected.verifiedComponents, ["database-dump", "avatar-archive"]);

  assert.ok(manifest.csvCases.some(({ value }) => /[\u3400-\u9fff]/u.test(value)), "CSV 必须覆盖中文");
  for (const prefix of ["=", "+", "-", "@"]) {
    assert.ok(manifest.csvCases.some(({ value, expectedEscaped }) => value.startsWith(prefix) && expectedEscaped.startsWith("'")), `CSV 缺少 ${prefix} 公式注入边界`);
  }
  assert.ok(manifest.fixtures["F-O"].clients.length <= 20, "F-O 测试客户端不得超过 20 个");
  assert.equal(manifest.fixtures["F-O"].capacityMeaning, "personal-test-evidence-only-not-a-production-capacity-commitment");

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

function expectRejected(schema, manifest, name, mutate) {
  const candidate = clone(manifest);
  mutate(candidate);
  assert.throws(() => validate(schema, candidate), undefined, `负例未被拒绝: ${name}`);
}

const schema = await readJson(schemaUrl, "schema");
const manifest = await readJson(manifestUrl, "manifest");
validate(schema, manifest);

const rejectionCases = [
  ["重复别名", (value) => value.fixtures["F-T"].aliases.push(value.fixtures["F-I"].aliases[0])],
  ["非确定时间", (value) => { value.fixtures["F-I"].tokens[0].expiresAt = "2027-01-01T00:00:00Z"; }],
  ["非确定 revision", (value) => { value.fixtures["F-A"].room.revision = 99; }],
  ["遗漏故事", (value) => { value.mvps.forEach((mvp) => { mvp.stories = mvp.stories.filter((story) => story !== 163); }); }],
  ["遗漏 MVP", (value) => { value.mvps.pop(); }],
  ["实现主键", (value) => { value.fixtures["F-I"].accounts[0].id = 123; }],
  ["真实秘密样式", (value) => { value.fixtures["F-I"].accounts[0].password = "hunter2"; }],
  ["缺少夹具主体", (value) => { delete value.fixtures["F-I"].accounts; }],
  ["恢复集摘要不一致", (value) => { value.fixtures["F-F"].restoreSet.manifestEntries[0].bytes = 99; }]
];
rejectionCases.forEach(([name, mutate]) => expectRejected(schema, manifest, name, mutate));
console.log(`MVP 验收 manifest 校验通过；${rejectionCases.length} 个语义负例均被拒绝。`);
