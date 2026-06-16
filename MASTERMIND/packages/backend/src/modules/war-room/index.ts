import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  Module,
  MastermindContext,
  WsServerMessage,
  WarRoom,
  WarRoomMember,
  WarRoomMessage,
  WarRoomDetail,
  CreateRoomInput,
  RoomStatus,
} from '@mastermind/shared';
import type { AgentModule } from '../agent/index.js';
import type { SessionModule } from '../session/index.js';
import type { ProviderModule } from '../provider/index.js';
import type { ConfigModule } from '../config/index.js';
import { summarizeWithLlm } from '../../utils/summarizeWithLlm.js';
import { buildBriefing, buildTurnNudge } from './rules.js';
import { writeWarRoomArchive } from './archive.js';

function genId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

const WAR_ROOM_TURN_TIMEOUT_MS = 60_000;

export class WarRoomModule implements Module {
  name = 'war-room';
  private ctx!: MastermindContext;
  /** Rooms currently running an agent turn — prevents double-trigger. */
  private runningRooms = new Set<string>();
  // Rooms with a pending abort (emergency stop). runTurnChain checks this at each
  // checkpoint and breaks. Set by abortRoom(), cleared when a fresh chain starts and
  // in runTurnChain's finally. See AUDIT-2026-06-01 C1.
  private abortedRooms = new Set<string>();

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    await this.cleanupZombieRooms();
    console.log('[war-room] Initialized');
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Any room left in 'open' status at startup is presumed crashed — we mark it
   * 'crashed' and set closed_at to make sure it doesn't auto-resume on restart.
   * Pattern mirrors SchedulerModule.cleanupZombieRuns.
   */
  private async cleanupZombieRooms(): Promise<void> {
    const res = await this.ctx.db.query<{ id: string }>(
      `UPDATE rooms SET status = 'crashed', closed_at = NOW()
       WHERE status = 'open' RETURNING id`,
    );
    if (!res.rowCount || res.rowCount === 0) return;

    const crashedRoomIds = res.rows.map(r => r.id);
    console.log(`[war-room] Cleaned up ${res.rowCount} zombie room(s) left open at restart: [${crashedRoomIds.join(',')}]`);

    // The normal close path deletes each room's dedicated `room-<roomId>-<agentId>` session
    // (see closeRoom), but the crash path historically did not — room_members.session_id has
    // NO cascading FK (schema.ts), so flipping the room to 'crashed' leaves those sessions
    // (briefing + broadcasted messages) orphaned in DB forever, accumulating one set per crash.
    // Mirror closeRoom's cleanup here. No abortAndWait needed: this runs at init, before any
    // run can be in flight, and the rooms just crashed so nothing is generating. See
    // AUDIT-2026-06-01 L14.
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    const { rows: memberRows } = await this.ctx.db.query<{ session_id: string }>(
      `SELECT session_id FROM room_members WHERE room_id = ANY($1::text[])`,
      [crashedRoomIds],
    );
    let deleted = 0;
    for (const { session_id } of memberRows) {
      try {
        await sessionMod.delete(session_id);
        deleted++;
      } catch (err) {
        console.warn(`[war-room] failed to delete orphaned session ${session_id} from crashed room:`, err instanceof Error ? err.message : String(err));
      }
    }
    if (deleted > 0) {
      console.log(`[war-room] Deleted ${deleted} orphaned session(s) from ${crashedRoomIds.length} crashed room(s)`);
    }
  }

  // ── CRUD ───────────────────────────────────────────────────

  async createRoom(input: CreateRoomInput): Promise<WarRoomDetail> {
    if (!input.name?.trim()) throw new Error('name is required');
    if (!input.memberAgentIds?.length) throw new Error('at least one agent member is required');

    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const sessionMod = this.ctx.modules.get<SessionModule>('session');

    // Validate all members exist
    for (const aid of input.memberAgentIds) {
      if (!agentMod.getAgent(aid)) throw new Error(`agent "${aid}" not found`);
    }
    // Deduplicate while preserving order
    const memberIds = [...new Set(input.memberAgentIds)];

    const roomId = genId('room');
    const maxMessages = Math.max(10, Math.min(2000, input.maxMessages ?? 200));
    const maxToolsPerTurn = Math.max(0, Math.min(20, input.maxToolsPerTurn ?? 5));

    const userName = input.userName?.trim() || 'User';
    await this.ctx.db.query(
      `INSERT INTO rooms (id, name, status, max_messages, max_tools_per_turn, turn_index, user_name)
       VALUES ($1, $2, 'open', $3, $4, 0, $5)`,
      [roomId, input.name.trim(), maxMessages, maxToolsPerTurn, userName],
    );

    // Create a fresh session per agent, insert the briefing as the first user message,
    // and register the membership row.
    const nowIso = new Date().toISOString();
    const participants = [
      { kind: 'user' as const, id: 'user', name: input.userName ?? 'User' },
      ...memberIds.map(aid => {
        const cfg = agentMod.getAgent(aid)!;
        return { kind: 'agent' as const, id: aid, name: cfg.identity.name ?? aid };
      }),
    ];

    for (let i = 0; i < memberIds.length; i++) {
      const agentId = memberIds[i];
      const orderIndex = i + 1;
      const sessionId = `room-${roomId}-${agentId}`;

      // Create the fresh session (getOrCreate is idempotent)
      await sessionMod.getOrCreate(sessionId, agentId);

      // Briefing as first user message — persisted so it sits in the conversation prefix.
      const agentCfg = agentMod.getAgent(agentId)!;
      const briefing = buildBriefing({
        roomName: input.name.trim(),
        participants,
        maxMessages,
        maxToolsPerTurn,
        yourAgentName: agentCfg.identity.name ?? agentId,
        yourAgentId: agentId,
      });
      await sessionMod.addMessage(sessionId, 'user', briefing, 'web', { warRoomId: roomId, kind: 'briefing' });

      await this.ctx.db.query(
        `INSERT INTO room_members (room_id, agent_id, session_id, order_index, joined_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [roomId, agentId, sessionId, orderIndex, nowIso],
      );
    }

    this.broadcast({ type: 'war-room.rooms.updated' });
    console.log(`[war-room] Created room ${roomId} "${input.name}" members=[${memberIds.join(',')}] maxMessages=${maxMessages} maxTools=${maxToolsPerTurn}`);

    const detail = await this.getRoomDetail(roomId);
    if (!detail) throw new Error('createRoom: failed to reload room after insert');
    return detail;
  }

  async listRooms(): Promise<WarRoom[]> {
    const { rows } = await this.ctx.db.query<RoomRow>(
      `SELECT * FROM rooms ORDER BY created_at DESC`,
    );
    return rows.map(rowToRoom);
  }

  async getRoom(roomId: string): Promise<WarRoom | null> {
    const { rows } = await this.ctx.db.query<RoomRow>(
      `SELECT * FROM rooms WHERE id = $1`,
      [roomId],
    );
    return rows[0] ? rowToRoom(rows[0]) : null;
  }

  async getRoomDetail(roomId: string): Promise<WarRoomDetail | null> {
    const room = await this.getRoom(roomId);
    if (!room) return null;
    const members = await this.listMembers(roomId);
    const messageCount = await this.getRoomMessageCount(roomId);
    const currentSpeaker: 'user' | string = room.turnIndex === 0
      ? 'user'
      : (members.find(m => m.orderIndex === room.turnIndex)?.agentId ?? 'user');
    return { ...room, members, currentSpeaker, messageCount };
  }

  async listMembers(roomId: string): Promise<WarRoomMember[]> {
    const { rows } = await this.ctx.db.query<MemberRow>(
      `SELECT * FROM room_members WHERE room_id = $1 ORDER BY order_index`,
      [roomId],
    );
    return rows.map(rowToMember);
  }

  async listMessages(roomId: string, limit = 500): Promise<WarRoomMessage[]> {
    const { rows } = await this.ctx.db.query<MessageRow>(
      `SELECT * FROM room_messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [roomId, limit],
    );
    return rows.map(rowToMessage);
  }

  private async getRoomMessageCount(roomId: string): Promise<number> {
    const { rows } = await this.ctx.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM room_messages WHERE room_id = $1`,
      [roomId],
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  // ── Speaking ──────────────────────────────────────────────

  /**
   * The user posts a message into the room. Inserts it into the canonical log,
   * broadcasts each non-user member's session with a prefixed user message
   * (so their next turn sees it), advances the turn pointer, and triggers the
   * auto-chain of agent turns until control returns to the user.
   */
  async postUserMessage(roomId: string, content: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) throw new Error(`room ${roomId} not found`);
    if (room.status !== 'open') throw new Error(`room ${roomId} is ${room.status}`);
    if (!content.trim()) throw new Error('content is empty');
    if (this.runningRooms.has(roomId)) {
      throw new Error('room is currently processing an agent turn');
    }

    const count = await this.getRoomMessageCount(roomId);
    if (count >= room.maxMessages) {
      this.broadcast({ type: 'war-room.status', roomId, status: 'open' });
      throw new Error(`room reached max_messages (${room.maxMessages})`);
    }

    await this.insertAndBroadcast(roomId, {
      authorKind: 'user',
      content: content.trim(),
    });

    // Broadcast to every agent's session as a prefixed user input for their next turn.
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    const members = await this.listMembers(roomId);
    for (const m of members) {
      await sessionMod.addMessage(
        m.sessionId,
        'user',
        `[${room.userName ?? 'User'}]: ${content.trim()}`,
        'web',
        { warRoomId: roomId, broadcastedFrom: 'user' },
      );
    }

    // Advance the turn pointer atomically: user (0) → first agent (1). Two concurrent
    // posts (double-click, two tabs) both insert+broadcast their message above (no content
    // loss), but only ONE may move the pointer 0→1 and kick the chain — otherwise the
    // pointer races to 2 and member #1 is skipped for the round. See AUDIT-2026-06-01 L13.
    const advanced = await this.tryAdvanceFromUserTurn(roomId);
    if (!advanced) {
      console.debug(`[war-room] postUserMessage ${roomId}: lost turn-advance race — chain already started by concurrent post/skip`);
      return;
    }
    // Auto-chain agent turns until control returns to the user (turn_index === 0)
    void this.runTurnChain(roomId);
  }

  /**
   * The user explicitly skips their turn. Advances the pointer to the next agent
   * and triggers the auto-chain. Used by the "Passer mon tour" button AND by the
   * frontend auto-pass mode (which fires this automatically when turn returns to user).
   */
  async skipUserTurn(roomId: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) throw new Error(`room ${roomId} not found`);
    if (room.status !== 'open') throw new Error(`room ${roomId} is ${room.status}`);
    if (room.turnIndex !== 0) throw new Error('not the user\'s turn');
    if (this.runningRooms.has(roomId)) {
      throw new Error('room is currently processing an agent turn');
    }

    // Atomic 0→1 hand-off: the room.turnIndex check above is a read-then-act and doesn't
    // protect against two concurrent skips (or a skip racing a post) both observing 0.
    // Only the winner advances and starts the chain. See AUDIT-2026-06-01 L13.
    const advanced = await this.tryAdvanceFromUserTurn(roomId);
    if (!advanced) {
      console.debug(`[war-room] skipUserTurn ${roomId}: lost turn-advance race — chain already started by concurrent post/skip`);
      return;
    }
    void this.runTurnChain(roomId);
  }

  // ── Turn chain ─────────────────────────────────────────────

  /**
   * Loops agent turns until the turn pointer lands back on the user OR an abort
   * condition triggers. Guarded by `runningRooms` to prevent concurrent chains
   * on the same room.
   */
  private async runTurnChain(roomId: string): Promise<void> {
    if (this.runningRooms.has(roomId)) {
      console.debug(`[war-room] runTurnChain skipped — already running for room ${roomId}`);
      return;
    }
    this.runningRooms.add(roomId);
    // Clear any stale abort flag from a previous (aborted) chain so this fresh run isn't killed instantly.
    this.abortedRooms.delete(roomId);

    try {
      let consecutivePasses = 0;
      while (true) {
        // Emergency stop requested — bail before starting the next turn.
        if (this.abortedRooms.has(roomId)) {
          console.log(`[war-room] runTurnChain: abort flag set for room ${roomId} — stopping chain`);
          // Hand the turn back to the user so resume is clean (skipUserTurn requires turn_index===0).
          await this.ctx.db.query(`UPDATE rooms SET turn_index = 0 WHERE id = $1`, [roomId]);
          this.broadcast({ type: 'war-room.turn', roomId, turnIndex: 0, speaker: 'user' });
          break;
        }
        const room = await this.getRoom(roomId);
        if (!room) break;
        if (room.status !== 'open') break;

        // Stop on user's turn — they have to submit or skip explicitly
        if (room.turnIndex === 0) {
          this.broadcast({ type: 'war-room.turn', roomId, turnIndex: 0, speaker: 'user' });
          break;
        }

        // Stop if max messages reached
        const count = await this.getRoomMessageCount(roomId);
        if (count >= room.maxMessages) {
          console.log(`[war-room] room ${roomId} reached max_messages (${room.maxMessages}) — auto-closing`);
          await this.closeRoom(roomId, 'max-messages');
          break;
        }

        // Resolve the current speaking member
        const members = await this.listMembers(roomId);
        const currentMember = members.find(m => m.orderIndex === room.turnIndex);
        if (!currentMember) {
          console.warn(`[war-room] room ${roomId} has turn_index=${room.turnIndex} but no matching member — resetting to 0`);
          await this.ctx.db.query(`UPDATE rooms SET turn_index = 0 WHERE id = $1`, [roomId]);
          break;
        }

        this.broadcast({
          type: 'war-room.turn',
          roomId,
          turnIndex: room.turnIndex,
          speaker: currentMember.agentId,
        });
        this.broadcast({ type: 'war-room.agent.thinking', roomId, agentId: currentMember.agentId });

        const passed = await this.runAgentTurn(roomId, currentMember, room, count);
        this.broadcast({ type: 'war-room.agent.done', roomId, agentId: currentMember.agentId, passed });

        // Abort may have fired during the agent turn — run() resolves with a partial on
        // abort (the race won't throw), so check explicitly before advancing the pointer.
        if (this.abortedRooms.has(roomId)) {
          console.log(`[war-room] room ${roomId} aborted mid-turn — stopping chain`);
          // Hand the turn back to the user so resume is clean (skipUserTurn requires turn_index===0).
          await this.ctx.db.query(`UPDATE rooms SET turn_index = 0 WHERE id = $1`, [roomId]);
          this.broadcast({ type: 'war-room.turn', roomId, turnIndex: 0, speaker: 'user' });
          break;
        }

        if (passed) {
          consecutivePasses++;
          // If every member has passed in a row AND the user hasn't spoken since, pause the chain.
          if (consecutivePasses >= members.length) {
            console.log(`[war-room] room ${roomId} all ${members.length} agents passed consecutively — waiting for user`);
            await this.ctx.db.query(`UPDATE rooms SET turn_index = 0 WHERE id = $1`, [roomId]);
            this.broadcast({ type: 'war-room.turn', roomId, turnIndex: 0, speaker: 'user' });
            break;
          }
        } else {
          consecutivePasses = 0;
        }

        await this.advanceTurn(roomId);
      }
    } catch (err) {
      console.error(`[war-room] runTurnChain error for room ${roomId}:`, err instanceof Error ? err.message : String(err));
    } finally {
      this.runningRooms.delete(roomId);
      this.abortedRooms.delete(roomId);
    }
  }

  /**
   * Runs a single agent turn. Returns true if the agent passed (`[PASS]`), false if
   * they contributed a real message.
   */
  private async runAgentTurn(
    roomId: string,
    member: WarRoomMember,
    room: WarRoom,
    currentMessages: number,
  ): Promise<boolean> {
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const nudge = buildTurnNudge(room.name, currentMessages, room.maxMessages);

    let collected = '';
    try {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const runPromise = agentMod.run(member.agentId, member.sessionId, nudge, 'web', {
        onChunk: (chunk) => { collected += chunk; },
        maxToolTurnsOverride: room.maxToolsPerTurn,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          agentMod.abort(member.agentId);
          reject(new Error(`war-room turn timed out after ${WAR_ROOM_TURN_TIMEOUT_MS / 1000}s`));
        }, WAR_ROOM_TURN_TIMEOUT_MS);
      });
      try {
        await Promise.race([runPromise, timeoutPromise]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[war-room] agent ${member.agentId} turn failed in room ${roomId}:`, errorMsg);
      // Persist the failure as a system note so the transcript reflects it.
      await this.insertAndBroadcast(roomId, {
        authorKind: 'system',
        content: `[ERROR] ${member.agentId} a echoue ce tour: ${errorMsg.slice(0, 500)}`,
      });
      return false;
    }

    // Strip <think> blocks before checking for [PASS] — the 9B may wrap the marker in thinking
    const cleaned = collected.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const isPass = /^\[?PASS\]?$/i.test(cleaned) || cleaned === '';

    if (isPass) {
      console.log(`[war-room] agent ${member.agentId} passed turn in room ${roomId}`);
      await this.insertAndBroadcast(roomId, {
        authorKind: 'agent',
        authorAgentId: member.agentId,
        content: '[PASS]',
        passed: true,
      });
      return true;
    }

    // Persist the substantive message in the canonical log AND broadcast it to the
    // other members' sessions as prefixed user input for their next turns.
    await this.insertAndBroadcast(roomId, {
      authorKind: 'agent',
      authorAgentId: member.agentId,
      content: cleaned,
    });
    await this.broadcastToOtherMembers(roomId, member.agentId, cleaned);
    return false;
  }

  /**
   * Broadcasts an agent's message to every OTHER member's session as a prefixed user message.
   * This is how cross-agent visibility works: each agent sees the others' contributions as
   * `[NAME]: ...` in their role=user history, but their own past turns as role=assistant.
   */
  private async broadcastToOtherMembers(roomId: string, fromAgentId: string, content: string): Promise<void> {
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const members = await this.listMembers(roomId);
    const fromName = agentMod.getAgent(fromAgentId)?.identity.name ?? fromAgentId;

    for (const m of members) {
      if (m.agentId === fromAgentId) continue;
      await sessionMod.addMessage(
        m.sessionId,
        'user',
        `[${fromName}]: ${content}`,
        'web',
        { warRoomId: roomId, broadcastedFrom: fromAgentId },
      );
    }
  }

  private async advanceTurn(roomId: string): Promise<void> {
    // turn_index cycles 0 (user) → 1..N (members) → 0
    const members = await this.listMembers(roomId);
    const total = members.length + 1; // +1 for the user slot
    await this.ctx.db.query(
      `UPDATE rooms SET turn_index = (turn_index + 1) % $1 WHERE id = $2`,
      [total, roomId],
    );
  }

  /**
   * Atomically hand the turn from the user (0) to the first agent (1). Only the caller
   * whose UPDATE actually flips 0→1 gets `true`; the DB serialises the transition so
   * concurrent user posts/skips (double-click, two tabs/devices while it's the user's
   * turn) can't each advance the pointer (0→1 then 1→2, which would skip member #1 for
   * the round). The loser gets `false` and must NOT start a second chain — the winner
   * already did. Mirrors the atomic check-then-act used in closeRoom (M16). See
   * AUDIT-2026-06-01 L13.
   */
  private async tryAdvanceFromUserTurn(roomId: string): Promise<boolean> {
    const res = await this.ctx.db.query(
      `UPDATE rooms SET turn_index = 1 WHERE id = $1 AND turn_index = 0 RETURNING id`,
      [roomId],
    );
    return !!res.rowCount && res.rowCount > 0;
  }

  // ── Message insertion + broadcast ─────────────────────────

  private async insertAndBroadcast(
    roomId: string,
    params: {
      authorKind: 'user' | 'agent' | 'system';
      authorAgentId?: string;
      content: string;
      passed?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): Promise<WarRoomMessage> {
    const id = genId('msg');
    const { rows } = await this.ctx.db.query<MessageRow>(
      `INSERT INTO room_messages (id, room_id, author_kind, author_agent_id, content, passed, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        id,
        roomId,
        params.authorKind,
        params.authorAgentId ?? null,
        params.content,
        params.passed ?? false,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ],
    );
    const message = rowToMessage(rows[0]);
    this.broadcast({ type: 'war-room.message', roomId, message });
    return message;
  }

  // ── Close + archive ───────────────────────────────────────

  async closeRoom(roomId: string, reason: 'user' | 'max-messages' | 'crashed' = 'user'): Promise<{ archivePath: string | null }> {
    const room = await this.getRoom(roomId);
    if (!room) throw new Error(`room ${roomId} not found`);
    if (room.status !== 'open') {
      console.log(`[war-room] closeRoom ${roomId} no-op (status=${room.status})`);
      return { archivePath: room.archivePath ?? null };
    }

    console.log(`[war-room] closing room ${roomId} reason=${reason}`);

    // ── Phase 1: immediate close (synchronous, fast) ───────
    // Atomic check-then-act: only the caller whose UPDATE actually flips status='open'→'closed'
    // proceeds with archive/summary/cleanup. Concurrent closers (e.g. user /close racing the
    // runTurnChain auto-close on max-messages) affect zero rows and no-op. The DB serialises the
    // transition, so we never double-archive or fire two LLM summary jobs. See AUDIT-2026-06-01 M16.
    const closeRes = await this.ctx.db.query(
      `UPDATE rooms SET status = 'closed', closed_at = NOW() WHERE id = $1 AND status = 'open' RETURNING id`,
      [roomId],
    );
    if (!closeRes.rowCount || closeRes.rowCount === 0) {
      console.log(`[war-room] closeRoom ${roomId} no-op (lost close race — already closing/closed)`);
      const fresh = await this.getRoom(roomId);
      return { archivePath: fresh?.archivePath ?? null };
    }
    this.broadcast({ type: 'war-room.status', roomId, status: 'closed' });

    // Signal any currently-running agent to stop now (synchronous — just trips the
    // AbortController). We await each run's cleanup later, right before deleting the
    // sessions (see AUDIT-2026-06-01 M18), so the archive-write I/O below overlaps with
    // the runs winding down.
    const members = await this.listMembers(roomId);
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    for (const m of members) {
      try { agentMod.abort(m.agentId); } catch { /* non-fatal */ }
    }

    // Write archive immediately WITH transcript only (no summary yet)
    let archivePath: string | null = null;
    const messages = await this.listMessages(roomId, 2000);
    try {
      const configMod = this.ctx.modules.get<ConfigModule>('config');
      const sharedMemoryDir = configMod.resolvePath(this.ctx.config.paths.sharedMemoryDir);
      const agentNames = new Map<string, string>();
      for (const m of members) {
        const cfg = agentMod.getAgent(m.agentId);
        if (cfg) agentNames.set(m.agentId, cfg.identity.name ?? m.agentId);
      }
      archivePath = await writeWarRoomArchive({
        sharedMemoryDir,
        room: { ...room, status: 'closed', closedAt: new Date().toISOString() },
        members,
        messages,
        summary: '_(resume en cours de generation...)_',
        agentNames,
      });
      await this.ctx.db.query(
        `UPDATE rooms SET archive_path = $1 WHERE id = $2`,
        [archivePath, roomId],
      );
    } catch (err) {
      console.error(`[war-room] archive write failed for room ${roomId}:`, err instanceof Error ? err.message : String(err));
    }

    // Cleanup the fresh sessions. Before deleting each session, WAIT for the agent's
    // in-flight run to finish its cleanup (the partial-response save in run.ts). A bare
    // abort() only signals the controller; the run then saves its partial via
    // addMessage(sessionId, 'assistant', ...) whose row REFERENCES sessions(id) ON DELETE
    // CASCADE. Deleting the session first races that INSERT → FK violation (re-thrown,
    // surfacing a bogus [ERROR] turn) or a silent cascade-delete of the just-saved partial.
    // abortAndWait re-aborts (no-op, idempotent) then awaits the tracked run promise, so by
    // the time we delete the session the partial is durably written. See AUDIT-2026-06-01 M18.
    const sessionMod = this.ctx.modules.get<SessionModule>('session');
    for (const m of members) {
      try { await agentMod.abortAndWait(m.agentId); } catch { /* non-fatal */ }
      try { await sessionMod.delete(m.sessionId); } catch { /* non-fatal */ }
    }

    this.broadcast({ type: 'war-room.closed', roomId, archivePath });
    this.broadcast({ type: 'war-room.rooms.updated' });

    // ── Phase 2: async summary generation (background, no timeout risk for the user) ───
    const capturedArchivePath = archivePath;
    const capturedRoom = { ...room, status: 'closed' as const, closedAt: new Date().toISOString() };
    setImmediate(async () => {
      try {
        console.log(`[war-room] generating summary for room ${roomId} (${messages.length} messages)...`);
        const summary = await this.generateSummary(capturedRoom, messages);
        await this.ctx.db.query(
          `UPDATE rooms SET summary = $1 WHERE id = $2`,
          [summary.slice(0, 5000), roomId],
        );
        // Rewrite the archive file with the actual summary if path exists
        if (capturedArchivePath) {
          const configMod = this.ctx.modules.get<ConfigModule>('config');
          const sharedMemoryDir = configMod.resolvePath(this.ctx.config.paths.sharedMemoryDir);
          const agentNames = new Map<string, string>();
          for (const m of members) {
            const cfg = agentMod.getAgent(m.agentId);
            if (cfg) agentNames.set(m.agentId, cfg.identity.name ?? m.agentId);
          }
          // writeWarRoomArchive derives its filename from a fresh second-precision timestamp,
          // so this second write almost always lands on a DIFFERENT file than the phase-1
          // placeholder. Repoint rooms.archive_path to the real-summary file and drop the stale
          // placeholder, otherwise the DB (and UI) keeps pointing at the resume-less version while
          // the real archive is an orphan. See AUDIT-2026-06-01 M17.
          const newArchivePath = await writeWarRoomArchive({
            sharedMemoryDir,
            room: capturedRoom,
            members,
            messages,
            summary,
            agentNames,
          });
          if (newArchivePath !== capturedArchivePath) {
            await this.ctx.db.query(
              `UPDATE rooms SET archive_path = $1 WHERE id = $2`,
              [newArchivePath, roomId],
            );
            // Remove the now-superseded placeholder file (best-effort).
            try {
              await fs.unlink(capturedArchivePath);
            } catch (unlinkErr) {
              console.warn(`[war-room] could not remove stale placeholder archive ${capturedArchivePath} for room ${roomId}:`, unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr));
            }
          }
          console.log(`[war-room] archive rewritten with summary for room ${roomId} (path=${newArchivePath})`);
        }
        // Notify frontend that the summary is now available
        this.broadcast({ type: 'war-room.rooms.updated' });
      } catch (err) {
        console.warn(`[war-room] async summary generation failed for room ${roomId}:`, err instanceof Error ? err.message : String(err));
        // Update DB with the error so the UI can show it
        await this.ctx.db.query(
          `UPDATE rooms SET summary = $1 WHERE id = $2`,
          [`_(resume automatique echoue)_\n\nErreur: ${err instanceof Error ? err.message : String(err)}`, roomId],
        ).catch(() => { /* non-fatal */ });
      }
    });

    return { archivePath };
  }

  /**
   * Generate a concise summary of the war room conversation using the default provider model.
   */
  private async generateSummary(room: WarRoom, messages: WarRoomMessage[]): Promise<string> {
    if (messages.length === 0) return '_(war room fermee sans message)_';

    const providerMod = this.ctx.modules.get<ProviderModule>('provider');
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    const model = this.ctx.config.defaults.model;

    // Prepare a clean transcript for the summarizer
    const transcript = messages
      .filter(m => !m.passed)
      .map(m => {
        const author = m.authorKind === 'user'
          ? (room.userName ?? 'User').toUpperCase()
          : m.authorKind === 'system'
            ? 'SYSTEM'
            : (agentMod.getAgent(m.authorAgentId ?? '')?.identity.name ?? m.authorAgentId ?? '?').toUpperCase();
        return `[${author}] ${m.content}`;
      })
      .join('\n\n');

    const prompt = [
      `Tu es charge de resumer une war room multi-agents intitulee "${room.name}".`,
      '',
      'Transcription complete ci-dessous. Produis un resume structure en markdown avec :',
      '1. Les decisions cles prises',
      '2. Les points d\'accord et de desaccord',
      '3. Les actions ou todos identifies',
      '4. Les questions laissees en suspens',
      '',
      'Reponds uniquement avec le resume, pas de preambule.',
      '',
      '---',
      '',
      transcript.slice(0, 40_000),
    ].join('\n');

    const res = await summarizeWithLlm(providerMod, { model, prompt });
    if (res.ok) return res.summary;
    console.warn(`[war-room] summary generation failed (${res.reason})`);
    return `_(resume automatique echoue [${res.reason}] — transcript brut disponible ci-dessous)_`;
  }

  // ── Abort ─────────────────────────────────────────────────

  async abortRoom(roomId: string): Promise<void> {
    // Record the abort intent immediately (before any await) so the running chain observes
    // it at its very next checkpoint — even while we're still fetching members below.
    this.abortedRooms.add(roomId);
    const members = await this.listMembers(roomId);
    const agentMod = this.ctx.modules.get<AgentModule>('agent');
    for (const m of members) {
      try { agentMod.abort(m.agentId); } catch { /* non-fatal */ }
    }
    // NOTE: do NOT delete runningRooms here — runTurnChain's finally is the sole owner.
    // Deleting it would let a concurrent postUserMessage/skipUserTurn start a 2nd chain on
    // the same room. The abort flag + finally handle teardown. See AUDIT-2026-06-01 C1.
    console.log(`[war-room] abort requested for room ${roomId} — chain will stop at next checkpoint`);
  }

  // ── WS helper ─────────────────────────────────────────────

  private broadcast(msg: WsServerMessage): void {
    this.ctx.ws.broadcastAll(msg);
  }
}

// ── Row types + mappers ────────────────────────────────────

interface RoomRow {
  id: string;
  name: string;
  status: string;
  max_messages: number;
  max_tools_per_turn: number;
  turn_index: number;
  user_name: string | null;
  created_at: Date;
  closed_at: Date | null;
  archive_path: string | null;
  summary: string | null;
}

function rowToRoom(row: RoomRow): WarRoom {
  return {
    id: row.id,
    name: row.name,
    status: row.status as RoomStatus,
    maxMessages: row.max_messages,
    maxToolsPerTurn: row.max_tools_per_turn,
    turnIndex: row.turn_index,
    userName: row.user_name ?? undefined,
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at?.toISOString(),
    archivePath: row.archive_path ?? undefined,
    summary: row.summary ?? undefined,
  };
}

interface MemberRow {
  room_id: string;
  agent_id: string;
  session_id: string;
  order_index: number;
  joined_at: Date;
}

function rowToMember(row: MemberRow): WarRoomMember {
  return {
    roomId: row.room_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    orderIndex: row.order_index,
    joinedAt: row.joined_at.toISOString(),
  };
}

interface MessageRow {
  id: string;
  room_id: string;
  author_kind: string;
  author_agent_id: string | null;
  content: string;
  passed: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

function rowToMessage(row: MessageRow): WarRoomMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    authorKind: row.author_kind as WarRoomMessage['authorKind'],
    authorAgentId: row.author_agent_id ?? undefined,
    content: row.content,
    passed: row.passed,
    metadata: row.metadata ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}
