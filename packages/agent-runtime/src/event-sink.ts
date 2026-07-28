import type { AgentEventSink, AgentEventRecord } from "./types.js";

export class InMemoryAgentEventSink implements AgentEventSink {
  readonly records: AgentEventRecord[] = [];

  async append(record: AgentEventRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}
