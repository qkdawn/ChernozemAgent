import type { TaskConversationMessage } from "@chernozem/contracts";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { DEMO_ORGANIZATION_ID } from "./field-store.js";

const { Pool } = pg;

export interface TaskConversationStore {
  ensureInitial(taskId: string, content: string, createdAt: string, requestMessage?: string | null): Promise<TaskConversationMessage>;
  appendExchange(taskId: string, userContent: string, assistantContent: string, createdAt: string): Promise<[TaskConversationMessage, TaskConversationMessage]>;
  list(taskId: string, limit?: number): Promise<TaskConversationMessage[]>;
}

export function createMemoryTaskConversationStore(): TaskConversationStore {
  const messages = new Map<string, TaskConversationMessage[]>();
  return {
    async ensureInitial(taskId, content, createdAt, requestMessage) {
      const current = messages.get(taskId) ?? [];
      const existing = current.find((message) => message.kind === "analysis_result");
      if (existing) return structuredClone(existing);
      const user = requestMessage ? createMessage(taskId, 1, "user", "chat", requestMessage, createdAt) : null;
      const initial = createMessage(taskId, user ? 2 : 1, "assistant", "analysis_result", content, createdAt);
      messages.set(taskId, [...(user ? [user] : []), initial, ...current].sort(bySequence));
      return structuredClone(initial);
    },
    async appendExchange(taskId, userContent, assistantContent, createdAt) {
      const current = messages.get(taskId) ?? [];
      const nextSequence = current.reduce((maximum, message) => Math.max(maximum, message.sequence), 0) + 1;
      const user = createMessage(taskId, nextSequence, "user", "chat", userContent, createdAt);
      const assistant = createMessage(taskId, nextSequence + 1, "assistant", "chat", assistantContent, new Date(Date.parse(createdAt) + 1).toISOString());
      messages.set(taskId, [...current, user, assistant].sort(bySequence));
      return [structuredClone(user), structuredClone(assistant)];
    },
    async list(taskId, limit = 50) {
      return (messages.get(taskId) ?? []).slice(-limit).map((message) => structuredClone(message));
    },
  };
}

export function createPostgresTaskConversationStore(databaseUrl: string, organizationId = DEMO_ORGANIZATION_ID): TaskConversationStore {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async ensureInitial(taskId, content, createdAt, requestMessage) {
      const id = randomUUID();
      if (requestMessage) {
        await pool.query(
          `INSERT INTO task_conversation_messages
            (id, organization_id, task_id, sequence, role, kind, content, created_at)
           VALUES ($1, $2, $3, 1, 'user', 'chat', $4, $5)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), organizationId, taskId, requestMessage, createdAt],
        );
      }
      const response = await pool.query(
        `INSERT INTO task_conversation_messages
          (id, organization_id, task_id, sequence, role, kind, content, created_at)
         VALUES ($1, $2, $3, $4, 'assistant', 'analysis_result', $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id, task_id, sequence, role, kind, content, created_at`,
        [id, organizationId, taskId, requestMessage ? 2 : 1, content, createdAt],
      );
      if (response.rows[0]) return toMessage(response.rows[0]);
      const existing = await pool.query(
        `SELECT id, task_id, sequence, role, kind, content, created_at
         FROM task_conversation_messages
         WHERE organization_id = $1 AND task_id = $2 AND kind = 'analysis_result'`,
        [organizationId, taskId],
      );
      if (!existing.rows[0]) throw new Error("任务对话初始消息保存失败。");
      return toMessage(existing.rows[0]);
    },
    async appendExchange(taskId, userContent, assistantContent, createdAt) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT id FROM analysis_tasks WHERE id = $1 AND organization_id = $2 FOR UPDATE",
          [taskId, organizationId],
        );
        const sequenceResponse = await client.query(
          "SELECT COALESCE(MAX(sequence), 0) AS maximum FROM task_conversation_messages WHERE organization_id = $1 AND task_id = $2",
          [organizationId, taskId],
        );
        const userSequence = Number(sequenceResponse.rows[0]?.maximum ?? 0) + 1;
        const assistantCreatedAt = new Date(Date.parse(createdAt) + 1).toISOString();
        const response = await client.query(
          `INSERT INTO task_conversation_messages
            (id, organization_id, task_id, sequence, role, kind, content, created_at)
           VALUES
            ($1, $2, $3, $4, 'user', 'chat', $5, $6),
            ($7, $2, $3, $8, 'assistant', 'chat', $9, $10)
           RETURNING id, task_id, sequence, role, kind, content, created_at`,
          [randomUUID(), organizationId, taskId, userSequence, userContent, createdAt, randomUUID(), userSequence + 1, assistantContent, assistantCreatedAt],
        );
        await client.query("COMMIT");
        const saved = response.rows.map(toMessage).sort(bySequence);
        return [saved[0]!, saved[1]!];
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async list(taskId, limit = 50) {
      const response = await pool.query(
        `SELECT id, task_id, sequence, role, kind, content, created_at
         FROM task_conversation_messages
         WHERE organization_id = $1 AND task_id = $2
         ORDER BY sequence DESC
         LIMIT $3`,
        [organizationId, taskId, limit],
      );
      return response.rows.map(toMessage).sort(bySequence);
    },
  };
}

function createMessage(taskId: string, sequence: number, role: TaskConversationMessage["role"], kind: TaskConversationMessage["kind"], content: string, createdAt: string): TaskConversationMessage {
  return { id: randomUUID(), taskId, sequence, role, kind, content, createdAt };
}

function toMessage(row: Record<string, unknown>): TaskConversationMessage {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    sequence: Number(row.sequence),
    role: row.role as TaskConversationMessage["role"],
    kind: row.kind as TaskConversationMessage["kind"],
    content: row.content as string,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}

function bySequence(left: TaskConversationMessage, right: TaskConversationMessage): number {
  return left.sequence - right.sequence;
}
