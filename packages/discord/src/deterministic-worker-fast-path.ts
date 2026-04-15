import type { WorkerAgentResult } from "@tango/core";
import type { WellnessToolPaths } from "./wellness-agent-tools.js";

export interface DeterministicWorkerFastPathInput {
  workerId: string;
  task: string;
  toolIds?: string[];
  wellnessToolPaths?: WellnessToolPaths;
  fatsecretExecutor?: (input: {
    method: string;
    params: Record<string, unknown>;
  }) => Promise<unknown>;
}

export async function tryExecuteDeterministicWorkerFastPath(
  _input: DeterministicWorkerFastPathInput,
): Promise<WorkerAgentResult | null> {
  // Roll back nutrition worker fast-paths so deterministic routing always
  // falls through to the LLM worker for nutrition writes.
  return null;
}
