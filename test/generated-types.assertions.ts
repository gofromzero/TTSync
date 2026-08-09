import type { components } from '../contracts/v1/generated/api';

type Command = components['schemas']['RoomCommand'];
type Result = components['schemas']['RoomCommandResult'];
type CommandType = Command['type'];
type ResultType = Result['type'];
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

declare const command: Command;
declare const result: Result;
if (command.type === 'transferHost') command.payload.targetMemberId;
if (result.type === 'transferHost') result.result.hostMemberId;
