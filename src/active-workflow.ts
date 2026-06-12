import type { WorkflowSnapshot } from "./display.js";

export interface ActiveWorkflow {
  readonly id: number;
  getSnapshot(): WorkflowSnapshot;
  isCompleted(): boolean;
  update(snapshot: WorkflowSnapshot, completed?: boolean): void;
  subscribe(listener: () => void): () => void;
}

export interface ActiveWorkflowStore {
  current: ActiveWorkflow | undefined;
  create(snapshot: WorkflowSnapshot): ActiveWorkflow;
  clear(workflow: ActiveWorkflow): void;
}

let nextWorkflowId = 1;

export function createActiveWorkflowStore(): ActiveWorkflowStore {
  return {
    current: undefined,
    create(snapshot) {
      const workflow = new ActiveWorkflowState(nextWorkflowId++, snapshot);
      this.current = workflow;
      return workflow;
    },
    clear(workflow) {
      if (this.current === workflow) this.current = undefined;
    },
  };
}

class ActiveWorkflowState implements ActiveWorkflow {
  private snapshot: WorkflowSnapshot;
  private completed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly id: number,
    snapshot: WorkflowSnapshot,
  ) {
    this.snapshot = snapshot;
  }

  getSnapshot(): WorkflowSnapshot {
    return this.snapshot;
  }

  isCompleted(): boolean {
    return this.completed;
  }

  update(snapshot: WorkflowSnapshot, completed = false): void {
    this.snapshot = snapshot;
    this.completed ||= completed;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
