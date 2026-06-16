export type RoomStatus = 'open' | 'closed' | 'crashed';
export type RoomMessageAuthorKind = 'user' | 'agent' | 'system';

/**
 * A War Room — a shared multi-agent brainstorming session.
 * Each member has a fresh dedicated session, isolated from their normal chat session.
 * The user sees a unified chronological view built from room_messages.
 */
export interface WarRoom {
  id: string;
  name: string;
  status: RoomStatus;
  maxMessages: number;
  maxToolsPerTurn: number;
  /** 0 = user's turn, 1..N = agent member at that order_index */
  turnIndex: number;
  /** Display name for the human facilitator */
  userName?: string;
  createdAt: string;
  closedAt?: string;
  archivePath?: string;
  summary?: string;
}

export interface WarRoomMember {
  roomId: string;
  agentId: string;
  /** Fresh session id allocated for this war room participation (prefixed with `room-<roomId>-<agentId>`). */
  sessionId: string;
  /** 1-based speaking order within the room. */
  orderIndex: number;
  joinedAt: string;
}

export interface WarRoomMessage {
  id: string;
  roomId: string;
  authorKind: RoomMessageAuthorKind;
  /** Null when authorKind is 'user' or 'system'. */
  authorAgentId?: string;
  content: string;
  /** True when this row is a [PASS] marker rather than a substantive message. */
  passed: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** Detail view returned by GET /api/war-rooms/:id */
export interface WarRoomDetail extends WarRoom {
  members: WarRoomMember[];
  /** Identifier of the participant whose turn it is now — 'user' or an agent id. */
  currentSpeaker: 'user' | string;
  messageCount: number;
}

export interface CreateRoomInput {
  name: string;
  memberAgentIds: string[];
  maxMessages?: number;
  maxToolsPerTurn?: number;
  /** Display name for the human facilitator (default: "User") */
  userName?: string;
}
