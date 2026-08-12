import type { components, paths } from '../contracts/v1/generated/api';

type Command = components['schemas']['RoomCommand'];
type Result = components['schemas']['RoomCommandResult'];
type CommandType = Command['type'];
type ResultType = Result['type'];
type Schemas = components['schemas'];
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type Branch<U, K extends PropertyKey, V> = U extends unknown ? U extends Record<K, V> ? U : never : never;

type Expected =
  | 'transferHost' | 'takeoverHost' | 'rotateParticipantCredential' | 'rotateSpectatorLink'
  | 'deleteRoom' | 'restoreRoom' | 'createPlayerCard' | 'updatePlayerCard'
  | 'claimPlayerCard' | 'releasePlayerCard' | 'revokePlayerCardClaim' | 'movePlayerCard'
  | 'setTeamCapacity' | 'createGameRecord' | 'updateGameRecord' | 'setRoomStatus';

type _CommandWireConsts = Assert<CommandType extends Expected ? Expected extends CommandType ? true : false : false>;
type _ResultWireConsts = Assert<ResultType extends Expected ? Expected extends ResultType ? true : false : false>;
type _EveryCommandBranchIsReachable = Assert<{ [K in Expected]: IsNever<Branch<Command, 'type', K>> extends false ? true : false }[Expected]>;
type _EveryResultBranchIsReachable = Assert<{ [K in Expected]: IsNever<Branch<Result, 'type', K>> extends false ? true : false }[Expected]>;
type _ResourceNotFoundCode = Assert<Schemas['ResourceNotFoundProblem']['code'] extends 'RESOURCE_NOT_FOUND' ? true : false>;
type _RoomNotFoundCode = Assert<Schemas['RoomNotFoundProblem']['code'] extends 'ROOM_NOT_FOUND' ? true : false>;
type _RevisionConflictCode = Assert<Schemas['RevisionConflictProblem']['code'] extends 'REVISION_CONFLICT' ? true : false>;
type _IdempotencyConflictCode = Assert<Schemas['IdempotencyConflictProblem']['code'] extends 'IDEMPOTENCY_CONFLICT' ? true : false>;
type _StateConflictCode = Assert<Schemas['StateConflictProblem']['code'] extends 'STATE_CONFLICT' ? true : false>;
type _RegistrationDeliveryUnavailableCode = Assert<paths['/v1/accounts']['post']['responses'][503]['content']['application/problem+json']['code'] extends 'SERVICE_UNAVAILABLE' ? true : false>;

declare const command: Command;
declare const result: Result;
if (command.type === 'transferHost') command.payload.targetMemberId;
if (result.type === 'transferHost') result.result.hostMemberId;
