import type { FieldConversationMessage } from "@chernozem/contracts";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { DEMO_ORGANIZATION_ID } from "./field-store.js";

const { Pool } = pg;

export interface FieldConversationStore {
  appendExchange(fieldId: string, userContent: string, assistantContent: string, createdAt: string): Promise<[FieldConversationMessage, FieldConversationMessage]>;
  list(fieldId: string, limit?: number): Promise<FieldConversationMessage[]>;
}

export function createMemoryFieldConversationStore(): FieldConversationStore {
  const messages = new Map<string, FieldConversationMessage[]>();
  return {
    async appendExchange(fieldId, userContent, assistantContent, createdAt) {
      const current = messages.get(fieldId) ?? [];
      const nextSequence = current.reduce((maximum, message) => Math.max(maximum, message.sequence), 0) + 1;
      const user = createMessage(fieldId, nextSequence, "user", userContent, createdAt);
      const assistant = createMessage(fieldId, nextSequence + 1, "assistant", assistantContent, new Date(Date.parse(createdAt) + 1).toISOString());
      messages.set(fieldId, [...current, user, assistant]);
      return [structuredClone(user), structuredClone(assistant)];
    },
    async list(fieldId, limit = 50) {
      return (messages.get(fieldId) ?? []).slice(-limit).map((message) => structuredClone(message));
    },
  };
}

export function createPostgresFieldConversationStore(databaseUrl: string, organizationId = DEMO_ORGANIZATION_ID): FieldConversationStore {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async appendExchange(fieldId, userContent, assistantContent, createdAt) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM fields WHERE id = $1 AND organization_id = $2 FOR UPDATE", [fieldId, organizationId]);
        const sequenceResponse = await client.query(
          "SELECT COALESCE(MAX(sequence), 0) AS maximum FROM field_conversation_messages WHERE organization_id = $1 AND field_id = $2",
          [organizationId, fieldId],
        );
        const userSequence = Number(sequenceResponse.rows[0]?.maximum ?? 0) + 1;
        const assistantCreatedAt = new Date(Date.parse(createdAt) + 1).toISOString();
        const response = await client.query(
          `INSERT INTO field_conversation_messages
            (id, organization_id, field_id, sequence, role, content, created_at)
           VALUES
            ($1, $2, $3, $4, 'user', $5, $6),
            ($7, $2, $3, $8, 'assistant', $9, $10)
           RETURNING id, field_id, sequence, role, content, created_at`,
          [randomUUID(), organizationId, fieldId, userSequence, userContent, createdAt, randomUUID(), userSequence + 1, assistantContent, assistantCreatedAt],
        );
        await client.query("COMMIT");
        const saved = response.rows.map(toMessage).sort((left, right) => left.sequence - right.sequence);
        return [saved[0]!, saved[1]!];
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async list(fieldId, limit = 50) {
      const response = await pool.query(
        `SELECT id, field_id, sequence, role, content, created_at
         FROM field_conversation_messages
         WHERE organization_id = $1 AND field_id = $2
         ORDER BY sequence DESC
         LIMIT $3`,
        [organizationId, fieldId, limit],
      );
      return response.rows.map(toMessage).sort((left, right) => left.sequence - right.sequence);
    },
  };
}

function createMessage(fieldId: string, sequence: number, role: FieldConversationMessage["role"], content: string, createdAt: string): FieldConversationMessage {
  return { id: randomUUID(), fieldId, sequence, role, content, createdAt };
}

function toMessage(row: Record<string, unknown>): FieldConversationMessage {
  return {
    id: row.id as string,
    fieldId: row.field_id as string,
    sequence: Number(row.sequence),
    role: row.role as FieldConversationMessage["role"],
    content: row.content as string,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  };
}
