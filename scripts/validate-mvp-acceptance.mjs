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

function validate(schema, manifest) {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://ttsync.test/specs/mvp-acceptance/schema.json");
  assert.equal(manifest.schemaVersion, "1.0.0");
  assert.equal(manifest.fixturePolicy?.semanticAliasesOnly, true);
  assert.equal(manifest.fixturePolicy?.containsRealSecrets, false);

  const expectedGroups = ["F-I", "F-T", "F-A", "F-F", "F-O"];
  assert.deepEqual(Object.keys(manifest.fixtures).sort(), expectedGroups);
  const aliases = [];
  for (const [group, fixture] of Object.entries(manifest.fixtures)) {
    assert.equal(fixture.id, group);
    assert.ok(Array.isArray(fixture.aliases) && fixture.aliases.length > 0, `${group} 必须声明 aliases`);
    aliases.push(...fixture.aliases);
  }
  assert.equal(new Set(aliases).size, aliases.length, "夹具语义别名不得重复");
  aliases.forEach((alias) => assert.match(alias, /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/, `非法语义别名: ${alias}`));

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

  const fileCategories = new Set(manifest.fixtures["F-F"].imageCases.map(({ category }) => category));
  ["valid-jpeg", "valid-png", "disguised", "animated", "corrupt", "over-byte-limit", "over-dimension-limit", "over-pixel-limit"].forEach((category) => {
    assert.ok(fileCategories.has(category), `F-F 缺少图片类别 ${category}`);
  });
  const assetStates = new Set(manifest.fixtures["F-F"].assets.map(({ state }) => state));
  ["referenced", "zero-reference"].forEach((state) => assert.ok(assetStates.has(state), `F-F 缺少资产状态 ${state}`));
  assert.equal(manifest.fixtures["F-F"].restoreSet.expected.digestVerification, "all-match");
  assert.equal(manifest.fixtures["F-F"].restoreSet.expected.missingFiles, 0);

  assert.ok(manifest.csvCases.some(({ value }) => /[\u3400-\u9fff]/u.test(value)), "CSV 必须覆盖中文");
  for (const prefix of ["=", "+", "-", "@"]) {
    assert.ok(manifest.csvCases.some(({ value, expectedEscaped }) => value.startsWith(prefix) && expectedEscaped.startsWith("'")), `CSV 缺少 ${prefix} 公式注入边界`);
  }
  assert.ok(manifest.fixtures["F-O"].clients.length <= 20, "F-O 测试客户端不得超过 20 个");
  assert.equal(manifest.fixtures["F-O"].capacityMeaning, "personal-test-evidence-only-not-a-production-capacity-commitment");

  const forbiddenKeys = /^(?:id|.*Id|.*_id|table|tableName|primaryKey|autoIncrementId|privateFunction)$/;
  const secretValue = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|postgres(?:ql)?:\/\/[^\s/:]+:[^\s@]+@|password\s*[:=]\s*(?!<TEST_ONLY>))/i;
  walk(manifest, (value, path) => {
    const key = path.split(".").at(-1);
    if (path !== "$.mvps[0].id" && forbiddenKeys.test(key) && !["id", "commandIds"].includes(key)) fail(`禁止绑定实现主键或私有实现: ${path}`);
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
  ["非确定时间", (value) => { value.determinism.times.epoch = "now"; }],
  ["非确定 revision", (value) => { value.determinism.revisions.changed = 99; }],
  ["遗漏故事", (value) => { value.mvps.forEach((mvp) => { mvp.stories = mvp.stories.filter((story) => story !== 163); }); }],
  ["遗漏 MVP", (value) => { value.mvps.pop(); }],
  ["实现主键", (value) => { value.fixtures["F-I"].tableName = "accounts"; }],
  ["真实秘密样式", (value) => { value.fixtures["F-O"].credential = "postgres://admin:real-secret@db/ttsync"; }]
];
rejectionCases.forEach(([name, mutate]) => expectRejected(schema, manifest, name, mutate));
console.log(`MVP 验收 manifest 校验通过；${rejectionCases.length} 个语义负例均被拒绝。`);
