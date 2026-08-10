/* 由 room-events.schema.json 自动生成；请勿直接修改。 */

/**
 * 房间失效通知只是重新读取权威快照的提示，不是领域事件、状态差量或可靠历史。SSE 的 id 等于 revision。
 */
export interface RoomInvalidationEvent {
  roomId: string;
  revision: number;
}
