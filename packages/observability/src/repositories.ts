import type {
  AgentApprovalHistoryRecord,
  AgentHistoryPage,
  AgentHistoryQuery,
  AgentHistoryRecord,
  AgentMessageHistoryRecord,
  AgentSessionHistoryRecord,
  AgentToolCallHistoryRecord,
  AgentToolResultHistoryRecord,
  AgentTurnHistoryRecord,
  SetHistoryPage,
  SetHistoryQuery,
  SetHistoryRecord,
  SetSaveHistoryRecord,
  SetSnapshotHistoryRecord,
  SetTrajectoryHistoryRecord,
} from "./contracts.js";

export interface AgentHistoryStore {
  appendAgentHistory(record: AgentHistoryRecord): Promise<void>;
  readAgentHistory(query?: AgentHistoryQuery): Promise<AgentHistoryPage>;
}

export interface SetHistoryStore {
  appendSetHistory(record: SetHistoryRecord): Promise<void>;
  readSetHistory(query?: SetHistoryQuery): Promise<SetHistoryPage>;
}

export class AgentHistoryRepository {
  public constructor(private readonly store: AgentHistoryStore) {}

  public append(record: AgentHistoryRecord): Promise<void> {
    return this.store.appendAgentHistory(record);
  }

  public appendSession(record: AgentSessionHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public appendTurn(record: AgentTurnHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public appendMessage(record: AgentMessageHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public appendToolCall(record: AgentToolCallHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public appendToolResult(record: AgentToolResultHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public appendApproval(record: AgentApprovalHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public read(query: AgentHistoryQuery = {}): Promise<AgentHistoryPage> {
    return this.store.readAgentHistory(query);
  }
}

export class SetHistoryRepository {
  public constructor(private readonly store: SetHistoryStore) {}

  public append(record: SetHistoryRecord): Promise<void> {
    return this.store.appendSetHistory(record);
  }

  public appendSave(record: SetSaveHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public appendSnapshot(record: SetSnapshotHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public appendTrajectory(record: SetTrajectoryHistoryRecord): Promise<void> {
    return this.append(record);
  }

  public read(query: SetHistoryQuery = {}): Promise<SetHistoryPage> {
    return this.store.readSetHistory(query);
  }
}
