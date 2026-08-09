import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const openapiPath = new URL('../contracts/v1/openapi.yaml', import.meta.url);
const eventSchemaPath = new URL('../contracts/v1/room-events.schema.json', import.meta.url);
const generateScriptPath = new URL('../scripts/generate-contract-types.mjs', import.meta.url);
const checkScriptPath = new URL('../scripts/check-contracts.mjs', import.meta.url);

async function loadOpenApi() {
  await SwaggerParser.validate(fileURLToPath(openapiPath));
  return parse(await readFile(openapiPath, 'utf8'));
}

async function loadDereferencedOpenApi() {
  return SwaggerParser.dereference(fileURLToPath(openapiPath));
}

function exampleValues(media) {
  return [
    ...(media.example === undefined ? [] : [{ value: media.example, valid: true }]),
    ...Object.values(media.examples ?? {}).map((example) => ({
      value: example.value,
      valid: example['x-schema-valid'] !== false,
    })),
  ];
}

const publicOperationIds = [
  'registerAccount', 'resendVerification', 'verifyEmail', 'login', 'logout',
  'logoutAllSessions', 'requestPasswordReset', 'resetPassword', 'changePassword',
  'changeEmail', 'getSession', 'createTeam', 'listTeams', 'createMember',
  'updateMember', 'createInvitation', 'acceptInvitation', 'createGameProject',
  'updateGameProject', 'createGameProfile', 'updateGameProfile', 'updateRecordTemplate',
  'createRoom', 'joinRoom', 'joinRoomAsSpectator', 'executeRoomCommand',
  'getRoomSnapshot', 'streamRoomInvalidations', 'getGameHistory', 'getGameStatistics',
  'exportGameRecords', 'uploadAvatar', 'getAvatar',
];

function responseSchema(api, name) {
  const schema = api.components.responses[name].content['application/problem+json'].schema;
  return schema.$ref ? api.components.schemas[schema.$ref.split('/').at(-1)] : schema;
}

test('公开合同可由标准解析器独立解析', async () => {
  const api = await loadOpenApi();
  const eventSchema = JSON.parse(await readFile(eventSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  assert.equal(ajv.compile(eventSchema)({ roomId: '018f5f1e-17d8-7a38-94d0-ecf3184ccf23', revision: 8 }), true);
  assert.equal(api.info.version, '1.0.0');
});

test('生成与漂移检查复用同一个纯类型生成 seam', async () => {
  for (const path of [generateScriptPath, checkScriptPath]) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /generateContractTypes/);
    assert.doesNotMatch(source, /from 'openapi-typescript'|from 'json-schema-to-typescript'/);
  }
});

test('每个 operation 固定标识、鉴权、请求、成功与完整错误集合', async () => {
  const api = await loadOpenApi();
  const requiredErrors = ['400', '401', '403', '404', '409', '422', '429', '500'];
  for (const pathItem of Object.values(api.paths)) {
    for (const operation of Object.values(pathItem).filter((value) => value?.responses)) {
      assert.match(operation.operationId, /^[a-z][A-Za-z0-9]+$/);
      assert.ok(operation.security?.length > 0);
      assert.ok(operation.parameters?.length > 0 || operation.requestBody);
      assert.ok(operation.responses['200']);
      for (const status of requiredErrors) assert.ok(operation.responses[status], `${operation.operationId} 缺少 ${status}`);
    }
  }
});

test('MVP-01 至 MVP-11 的公开 HTTP operation 完整且稳定', async () => {
  const api = await loadOpenApi();
  const actual = Object.values(api.paths).flatMap((pathItem) =>
    Object.values(pathItem).filter((value) => value?.operationId).map((operation) => operation.operationId));
  assert.deepEqual(actual.sort(), [...publicOperationIds].sort());
});

test('房间命令、成功结果和样例固定并发与幂等语义', async () => {
  const api = await loadOpenApi();
  const schemas = api.components.schemas;
  for (const branchRef of schemas.RoomCommand.oneOf) {
    const branch = schemas[branchRef.$ref.split('/').at(-1)];
    assert.deepEqual(branch.required, ['roomId', 'commandId', 'expectedRevision', 'type', 'payload']);
  }
  for (const branchRef of schemas.RoomCommandResult.oneOf) {
    const branch = schemas[branchRef.$ref.split('/').at(-1)];
    assert.deepEqual(branch.required, ['roomId', 'commandId', 'changed', 'revision', 'type', 'result']);
  }
  assert.equal(schemas.RoomCommandResult.properties.snapshot, undefined);
  const examples = api.paths['/v1/rooms/{roomId}/commands'].post.requestBody.content['application/json'].examples;
  assert.ok(examples.changedCommand && examples.noChangeCommand && examples.staleRevision && examples.idempotencyFingerprintConflict && examples.multipleViolations);
});

test('命令、结果及角色快照使用封闭的可辨识 union', async () => {
  const api = await loadOpenApi();
  const schemas = api.components.schemas;
  assert.equal(schemas.RoomCommand.discriminator.propertyName, 'type');
  assert.ok(schemas.RoomCommand.oneOf.length >= 8);
  assert.equal(schemas.RoomCommandResult.discriminator.propertyName, 'type');
  assert.ok(schemas.RoomCommandResult.oneOf.length >= 8);
  for (const union of [schemas.RoomCommand, schemas.RoomCommandResult]) {
    for (const branchRef of union.oneOf) {
      let branch = schemas[branchRef.$ref.split('/').at(-1)];
      if (branch.$ref) branch = schemas[branch.$ref.split('/').at(-1)];
      const variant = branch.allOf?.find((item) => item.properties?.type) ?? branch;
      assert.equal(typeof variant?.properties.type.const, 'string');
      const body = variant.properties.payload ?? variant.properties.result;
      assert.equal(body.additionalProperties, false);
    }
  }
  assert.equal(schemas.RoomSnapshot.discriminator.propertyName, 'role');
  assert.equal(schemas.RoomSnapshot.oneOf.length, 3);
  for (const name of ['HostRoomSnapshot', 'ParticipantRoomSnapshot', 'SpectatorRoomSnapshot']) {
    assert.equal(schemas[name].additionalProperties, false);
  }
});

test('Problem Details、状态码语义和快照禁止缓存均已固定', async () => {
  const api = await loadOpenApi();
  const problem = api.components.schemas.ProblemDetails;
  assert.deepEqual(problem.required, ['type', 'title', 'detail', 'instance', 'requestId']);
  assert.equal(problem.properties.status, undefined);
  assert.equal(problem.properties.code, undefined);
  assert.deepEqual(api.components.schemas.Violation.required, ['path', 'code', 'message']);
  const snapshot = api.paths['/v1/rooms/{roomId}/snapshot'].get.responses['200'];
  assert.deepEqual(snapshot.headers['Cache-Control'].schema.enum, ['no-store']);
  assert.match(snapshot.description, /Caddy|浏览器|条件读取/);
});

test('全部错误状态均提供可解析的 Problem Details 样例', async () => {
  const api = await loadOpenApi();
  const responseNames = [
    'BadRequest',
    'Unauthorized',
    'Forbidden',
    'NotFound',
    'Conflict',
    'UnprocessableEntity',
    'TooManyRequests',
    'InternalServerError',
  ];
  for (const name of responseNames) {
    const media = api.components.responses[name].content['application/problem+json'];
    assert.ok(media.example || media.examples, `${name} 缺少 Problem Details 样例`);
  }
});

test('全部 OpenAPI request/response examples 均符合对应 schema', async () => {
  const api = await loadDereferencedOpenApi();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validateMediaExamples = (media, location) => {
    if (!media?.schema) return;
    const validate = ajv.compile(media.schema);
    for (const example of exampleValues(media)) {
      assert.equal(validate(example.value), example.valid, `${location}: ${ajv.errorsText(validate.errors)}`);
    }
  };

  for (const [path, pathItem] of Object.entries(api.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation?.responses) continue;
      for (const [mediaType, media] of Object.entries(operation.requestBody?.content ?? {})) {
        validateMediaExamples(media, `${method.toUpperCase()} ${path} request ${mediaType}`);
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        for (const [mediaType, media] of Object.entries(response.content ?? {})) {
          validateMediaExamples(media, `${method.toUpperCase()} ${path} response ${status} ${mediaType}`);
        }
      }
    }
  }
});

test('每类错误响应窄化 status/code 并强制所需扩展', async () => {
  const api = await loadOpenApi();
  const expectations = {
    BadRequest: [400, ['MALFORMED_REQUEST']], Unauthorized: [401, ['UNAUTHORIZED']],
    Forbidden: [403, ['FORBIDDEN']], NotFound: [404, ['RESOURCE_NOT_FOUND', 'ROOM_NOT_FOUND']],
    Conflict: [409, ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'STATE_CONFLICT']],
    UnprocessableEntity: [422, ['VALIDATION_FAILED']], TooManyRequests: [429, ['RATE_LIMITED']],
    InternalServerError: [500, ['INTERNAL_ERROR']],
  };
  for (const [name, [status, codes]] of Object.entries(expectations)) {
    const schema = responseSchema(api, name);
    const branches = schema.oneOf?.map((branch) => api.components.schemas[branch.$ref.split('/').at(-1)]) ?? [schema];
    assert.ok(branches.every((branch) => branch.properties.status.const === status), `${name} status 未窄化`);
    assert.deepEqual(branches.flatMap((branch) => branch.properties.code.enum ?? [branch.properties.code.const]), codes, `${name} code 未窄化`);
  }
  const conflict = responseSchema(api, 'Conflict');
  assert.ok(conflict.oneOf.some((branch) => api.components.schemas[branch.$ref.split('/').at(-1)].required.includes('currentRevision')));
  assert.ok(responseSchema(api, 'UnprocessableEntity').required.includes('violations'));
});

test('失效通知仅允许 roomId/revision，SSE 固定心跳与恢复语义', async () => {
  const eventSchema = JSON.parse(await readFile(eventSchemaPath, 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(eventSchema);
  assert.equal(validate({ roomId: '018f5f1e-17d8-7a38-94d0-ecf3184ccf23', revision: 9 }), true);
  assert.equal(validate({ roomId: '018f5f1e-17d8-7a38-94d0-ecf3184ccf23', revision: 9, payload: {} }), false);
  const api = await loadOpenApi();
  const response = api.paths['/v1/rooms/{roomId}/events'].get.responses['200'];
  const stream = response.content['text/event-stream'];
  assert.equal(response['x-sse-heartbeat-interval-seconds'], 15);
  assert.equal(response['x-sse-heartbeat-format'], ': heartbeat');
  assert.equal(response['x-sse-event-id'], 'revision');
  assert.match(response.description, /完整快照/);
  assert.match(response.description, /历史/);
  assert.deepEqual(response['x-sse-subscription-order'], ['subscribe', 'read-current-revision', 'send-current-revision']);
  assert.equal(response['x-sse-listener-failure-action'], 'close-stream-for-reconnect');
});

test('生成的 wire union 可由 TypeScript 按每个 const 缩窄且分支不为 never', () => {
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc',
    '--noEmit', '--strict', '--skipLibCheck', 'test/generated-types.assertions.ts',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('房间命令覆盖 MVP-04 至 MVP-08 的全部写能力且每种有专属结果', async () => {
  const api = await loadOpenApi();
  const schemas = api.components.schemas;
  const expected = [
    'transferHost', 'takeoverHost', 'rotateParticipantCredential', 'rotateSpectatorLink',
    'deleteRoom', 'restoreRoom', 'createPlayerCard', 'updatePlayerCard',
    'claimPlayerCard', 'releasePlayerCard', 'revokePlayerCardClaim', 'movePlayerCard',
    'setTeamCapacity', 'createGameRecord', 'updateGameRecord', 'setRoomStatus',
  ];
  assert.deepEqual(schemas.RoomCommand.properties.type.enum, expected);
  assert.deepEqual(schemas.RoomCommandResult.properties.type.enum, expected);
  assert.equal(schemas.RoomCommand.oneOf.length, expected.length);
  assert.equal(schemas.RoomCommandResult.oneOf.length, expected.length);
  for (const type of expected) {
    const commandName = `${type[0].toUpperCase()}${type.slice(1)}Command`;
    const resultName = `${type[0].toUpperCase()}${type.slice(1)}Result`;
    assert.ok(schemas[commandName], `${type} 缺少专属命令`);
    assert.ok(schemas[resultName], `${type} 缺少专属结果`);
    assert.equal(schemas[commandName].properties.type.const, type);
    assert.equal(schemas[resultName].properties.type.const, type);
    assert.equal(schemas[commandName].properties.payload.additionalProperties, false);
    assert.equal(schemas[resultName].properties.result.additionalProperties, false);
  }
});

test('每个 operation 的成功响应绑定专属严格 schema 与正确媒体类型', async () => {
  const api = await loadOpenApi();
  for (const pathItem of Object.values(api.paths)) {
    for (const operation of Object.values(pathItem).filter((value) => value?.operationId)) {
      const success = operation.responses['200'];
      const expectedMedia = operation.operationId === 'streamRoomInvalidations' ? 'text/event-stream'
        : operation.operationId === 'getAvatar' ? 'image/png'
          : operation.operationId === 'exportGameRecords' ? 'text/csv' : 'application/json';
      assert.deepEqual(Object.keys(success.content), [expectedMedia], `${operation.operationId} 成功媒体类型不专属`);
      const schema = success.content[expectedMedia].schema;
      if (expectedMedia === 'application/json') {
        assert.equal(schema.$ref, `#/components/schemas/${operation.operationId[0].toUpperCase()}${operation.operationId.slice(1)}Response`);
        const responseSchema = api.components.schemas[schema.$ref.split('/').at(-1)];
        assert.equal(responseSchema.type, 'object');
        assert.equal(responseSchema.additionalProperties, false);
        assert.ok(responseSchema.required?.length > 0);
      }
    }
  }
});

test('三角色快照分别固定可见字段、认领可见性与主持秘密隔离', async () => {
  const api = await loadOpenApi();
  const schemas = api.components.schemas;
  const host = schemas.HostRoomSnapshot.properties;
  const participant = schemas.ParticipantRoomSnapshot.properties;
  const spectator = schemas.SpectatorRoomSnapshot.properties;
  for (const role of [schemas.HostRoomSnapshot, schemas.ParticipantRoomSnapshot, schemas.SpectatorRoomSnapshot]) {
    assert.equal(role.additionalProperties, false);
    assert.ok(role.required.includes('claims'));
    assert.ok(role.required.includes('capabilities'));
  }
  assert.ok(host.managementSecrets);
  assert.equal(participant.managementSecrets, undefined);
  assert.equal(spectator.managementSecrets, undefined);
  assert.ok(participant.participantSession);
  assert.equal(host.participantSession, undefined);
  assert.equal(spectator.participantSession, undefined);
});

test('错误扩展仅出现在匹配错误类型且 status/code 均为必填窄值', async () => {
  const api = await loadOpenApi();
  for (const [name, response] of Object.entries(api.components.responses)) {
    const schema = responseSchema(api, name);
    const branches = schema.oneOf ?? [schema];
    for (const branch of branches) {
      const resolved = branch.$ref ? api.components.schemas[branch.$ref.split('/').at(-1)] : branch;
      assert.ok(resolved.required.includes('status'), `${name} status 非必填`);
      assert.ok(resolved.required.includes('code'), `${name} code 非必填`);
      assert.ok(resolved.properties.status.const !== undefined);
      assert.ok(resolved.properties.code.const !== undefined || resolved.properties.code.enum?.length);
      const codes = resolved.properties.code.enum ?? [resolved.properties.code.const];
      assert.equal(Boolean(resolved.properties.currentRevision), codes.includes('REVISION_CONFLICT'));
      assert.equal(Boolean(resolved.properties.violations), codes.includes('VALIDATION_FAILED'));
    }
  }
  assert.equal(api.components.schemas.ProblemDetails.properties.currentRevision, undefined);
  assert.equal(api.components.schemas.ProblemDetails.properties.violations, undefined);
});

test('SSE 对 204 终态和流中鉴权失效定义可机读关闭重建路径', async () => {
  const api = await loadOpenApi();
  const operation = api.paths['/v1/rooms/{roomId}/events'].get;
  assert.equal(operation.responses['204'].description.length > 0, true);
  assert.deepEqual(operation['x-sse-terminal-response'], { status: 204, action: 'stop-reconnecting' });
  assert.deepEqual(operation['x-sse-auth-expiry-flow'], [
    'close-stream', 'refresh-access', 'read-role-snapshot', 'create-new-event-source',
  ]);
  assert.deepEqual(operation['x-sse-reconnect-calibration'], [
    'subscribe', 'read-role-snapshot', 'send-current-revision',
  ]);
  assert.equal(operation['x-sse-listener-failure-action'], 'close-stream-for-reconnect');
});
