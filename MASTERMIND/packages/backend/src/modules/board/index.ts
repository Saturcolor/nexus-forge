import { randomBytes } from 'node:crypto';
import type { Module, MastermindContext, BoardNote } from '@mastermind/shared';

const MAX_CONTENT_LENGTH = 500;
const MAX_ACTIVE_NOTES = 50;
const DEFAULT_TTL_HOURS = 24;

function genId(): string {
  return `bn-${randomBytes(6).toString('hex')}`;
}

export class BoardModule implements Module {
  name = 'board';
  private ctx!: MastermindContext;

  async init(ctx: MastermindContext): Promise<void> {
    this.ctx = ctx;
    await this.purgeExpired();
    console.log('[board] Initialized');
  }

  // ── CRUD ───────────────────────────────────────────────────

  async write(agentId: string, content: string, ttlHours?: number): Promise<BoardNote> {
    if (!content.trim()) {
      console.warn(`[board] write rejected empty agent=${agentId}`);
      throw new Error('board_write: content is empty');
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      console.warn(`[board] write rejected too long agent=${agentId} len=${content.length} max=${MAX_CONTENT_LENGTH}`);
      throw new Error(`board_write: content too long (${content.length} chars, max ${MAX_CONTENT_LENGTH}). Synthesize your note to be shorter.`);
    }

    const ttl = Math.max(1, Math.min(48, ttlHours ?? DEFAULT_TTL_HOURS));
    const id = genId();
    const expiresAt = new Date(Date.now() + ttl * 3600_000);

    // Enforce cap atomically. A separate COUNT-then-purge-then-INSERT sequence is
    // a check-then-act race: concurrent writers can each observe activeCount < MAX,
    // all skip the purge, then all INSERT → transient overshoot of MAX_ACTIVE_NOTES.
    // Instead, do INSERT + trim in a single statement (one implicit transaction):
    // insert the new note, then delete any active rows beyond the newest MAX, so the
    // active set is never left above the cap regardless of concurrency.
    const { rows } = await this.ctx.db.query<NoteRow>(
      `WITH inserted AS (
         INSERT INTO board_notes (id, agent_id, content, created_at, expires_at)
         VALUES ($1, $2, $3, NOW(), $4) RETURNING *
       ),
       trimmed AS (
         DELETE FROM board_notes
         WHERE id IN (
           SELECT id FROM board_notes
           WHERE expires_at > NOW()
           ORDER BY created_at DESC, id DESC
           OFFSET $5
         )
         RETURNING id
       )
       SELECT * FROM inserted`,
      [id, agentId, content.trim(), expiresAt.toISOString(), MAX_ACTIVE_NOTES],
    );

    console.log(`[board] write agent=${agentId} id=${id} ttl=${ttl}h len=${content.trim().length}`);
    return rowToNote(rows[0]);
  }

  async deleteNote(noteId: string): Promise<boolean> {
    const res = await this.ctx.db.query(
      `DELETE FROM board_notes WHERE id = $1`,
      [noteId],
    );
    if (res.rowCount && res.rowCount > 0) {
      console.log(`[board] delete id=${noteId}`);
      return true;
    }
    console.warn(`[board] delete id=${noteId} not found`);
    return false;
  }

  async listActive(): Promise<BoardNote[]> {
    const { rows } = await this.ctx.db.query<NoteRow>(
      `SELECT * FROM board_notes WHERE expires_at > NOW() ORDER BY created_at ASC`,
    );
    console.debug(`[board] listActive rows=${rows.length}`);
    return rows.map(rowToNote);
  }

  // ── Prompt injection ───────────────────────────────────────

  /**
   * Build the board block to inject into every agent's user message.
   * Returns empty string if no active notes. Called from agent/run.ts
   * alongside buildMemoryContext.
   */
  async buildBoardBlock(agentNames: Map<string, string>): Promise<string> {
    const notes = await this.listActive();
    if (notes.length === 0) {
      console.debug('[board] buildBoardBlock empty');
      return '';
    }

    const lines = notes.map(n => {
      const name = agentNames.get(n.agentId) ?? n.agentId;
      const ts = n.createdAt.slice(11, 16);
      const exp = n.expiresAt.slice(11, 16);
      return `[${name} · ${ts} · expire ${exp}] ${n.content}  (id=${n.id})`;
    });

    const block = [
      `[BOARD — ${notes.length} active note${notes.length > 1 ? 's' : ''}, delete processed notes with board_delete]`,
      ...lines,
      `[/BOARD]`,
    ].join('\n');
    console.debug(`[board] buildBoardBlock notes=${notes.length} chars=${block.length}`);
    return block;
  }

  // ── Purge ──────────────────────────────────────────────────

  /** Called from scheduler tick or at init — removes expired notes. */
  async purgeExpired(): Promise<number> {
    const res = await this.ctx.db.query(
      `DELETE FROM board_notes WHERE expires_at <= NOW()`,
    );
    const count = res.rowCount ?? 0;
    if (count > 0) {
      console.log(`[board] purged ${count} expired note(s)`);
    } else {
      console.debug('[board] purgeExpired no expired notes');
    }
    return count;
  }
}

// ── Row types ────────────────────────────────────────────────

interface NoteRow {
  id: string;
  agent_id: string;
  content: string;
  created_at: Date;
  expires_at: Date;
}

function rowToNote(row: NoteRow): BoardNote {
  return {
    id: row.id,
    agentId: row.agent_id,
    content: row.content,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
