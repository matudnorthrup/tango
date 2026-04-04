import fs from "node:fs";
import path from "node:path";
import {
  loadAgentConfigs,
  loadProjectConfigs,
  loadIntentContractConfigs,
  loadToolContractConfigs,
  loadWorkflowConfigs,
  loadWorkerConfigs,
  resolveConfigDir,
} from "./config.js";
import type {
  AgentConfig,
  IntentContractConfig,
  ProjectConfig,
  ToolContractConfig,
  WorkflowConfig,
  WorkerConfig,
  WorkerWriteScope,
} from "./types.js";

export interface PlannerToolContractSummary {
  id: string;
  family: string;
  description: string;
  mode: ToolContractConfig["mode"];
  integration: ToolContractConfig["integration"];
  inputFields: string[];
  outputFields: string[];
}

export interface PlannerWorkflowSummary {
  id: string;
  displayName?: string;
  description: string;
  /**
   * Workflow summaries describe reusable task contracts that route to an owning
   * worker. They are not meant to imply fixed query plans that bypass worker
   * reasoning.
   */
  ownerWorkerId: string;
  ownerWorkerDisplayName?: string;
  mode: WorkflowConfig["mode"];
  status?: WorkflowConfig["status"];
  confirmationRequired?: boolean;
  handler: string;
  inputFields: string[];
  examples: string[];
  planningSummary?: string;
  planningWhenToUse: string[];
  planningClarifications: string[];
  toolContracts: PlannerToolContractSummary[];
  workerToolsDoc?: string;
}

export interface PlannerCatalog {
  agentId: string;
  agentDisplayName?: string;
  agentToolsDoc?: string;
  projectId?: string;
  workflows: PlannerWorkflowSummary[];
}

export interface PlannerWorkerSummary {
  id: string;
  type: string;
  displayName?: string;
  description?: string;
  ownerAgentId?: string;
  providerDefault?: string;
  writeScope?: WorkerWriteScope;
  confirmBeforeWrite?: boolean;
  promptText?: string;
  toolContracts: PlannerToolContractSummary[];
  workerToolsDoc?: string;
}

export interface WorkerPlannerCatalog {
  agentId: string;
  agentDisplayName?: string;
  agentToolsDoc?: string;
  projectId?: string;
  workers: PlannerWorkerSummary[];
}

export interface IntentCatalogFilter {
  domain?: string;
}

export class CapabilityRegistry {
  private readonly agentsById = new Map<string, AgentConfig>();
  private readonly projectsById = new Map<string, ProjectConfig>();
  private readonly workersById = new Map<string, WorkerConfig>();
  private readonly toolContractsById = new Map<string, ToolContractConfig>();
  private readonly workflowsById = new Map<string, WorkflowConfig>();
  private readonly intentContractsById = new Map<string, IntentContractConfig>();

  constructor(input: {
    agents: AgentConfig[];
    projects: ProjectConfig[];
    workers: WorkerConfig[];
    toolContracts: ToolContractConfig[];
    workflows: WorkflowConfig[];
    intentContracts?: IntentContractConfig[];
  }) {
    for (const agent of input.agents) {
      this.agentsById.set(agent.id, agent);
    }
    for (const project of input.projects) {
      this.projectsById.set(project.id, project);
    }
    for (const worker of input.workers) {
      this.workersById.set(worker.id, worker);
    }
    for (const contract of input.toolContracts) {
      this.toolContractsById.set(contract.id, contract);
    }
    for (const workflow of input.workflows) {
      this.workflowsById.set(workflow.id, workflow);
    }
    for (const intentContract of input.intentContracts ?? []) {
      this.intentContractsById.set(intentContract.id, intentContract);
    }

    this.validate();
  }

  getWorkflow(id: string): WorkflowConfig | null {
    return this.workflowsById.get(id) ?? null;
  }

  getWorker(id: string): WorkerConfig | null {
    return this.workersById.get(id) ?? null;
  }

  getToolContract(id: string): ToolContractConfig | null {
    return this.toolContractsById.get(id) ?? null;
  }

  getIntentCatalog(
    agentId: string,
    projectId?: string | null,
    filter?: IntentCatalogFilter,
  ): IntentContractConfig[] {
    const accessibleWorkerIds = this.resolveAccessibleWorkerIds(agentId, projectId ?? undefined);

    return [...this.intentContractsById.values()]
      .filter((intentContract) => !filter?.domain || intentContract.domain === filter.domain)
      .filter((intentContract) => {
        if (intentContract.route.kind === "worker") {
          return accessibleWorkerIds.has(intentContract.route.targetId);
        }
        const workflow = this.workflowsById.get(intentContract.route.targetId);
        return workflow ? accessibleWorkerIds.has(workflow.ownerWorkerId) : false;
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getPlannerCatalog(agentId: string, projectId?: string | null): PlannerCatalog {
    const agent = this.agentsById.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent '${agentId}' in capability registry.`);
    }

    const accessibleWorkerIds = this.resolveAccessibleWorkerIds(agentId, projectId ?? undefined);
    const workflows = [...this.workflowsById.values()]
      .filter((workflow) => accessibleWorkerIds.has(workflow.ownerWorkerId))
      .map((workflow) => this.toPlannerWorkflowSummary(workflow))
      .sort((left, right) => left.id.localeCompare(right.id));

    return {
      agentId,
      agentDisplayName: agent.displayName,
      agentToolsDoc: loadAdjacentToolsDoc(agent.promptFile),
      projectId: projectId ?? undefined,
      workflows,
    };
  }

  getWorkerCatalog(agentId: string, projectId?: string | null): WorkerPlannerCatalog {
    const agent = this.agentsById.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent '${agentId}' in capability registry.`);
    }

    const accessibleWorkerIds = this.resolveAccessibleWorkerIds(agentId, projectId ?? undefined);
    const projectToolContractIds = this.resolveProjectToolContractIds(projectId ?? undefined);
    const workers = [...this.workersById.values()]
      .filter((worker) => accessibleWorkerIds.has(worker.id))
      .map((worker) => this.toPlannerWorkerSummary(worker, projectToolContractIds))
      .sort((left, right) => left.id.localeCompare(right.id));

    return {
      agentId,
      agentDisplayName: agent.displayName,
      agentToolsDoc: loadAdjacentToolsDoc(agent.promptFile),
      projectId: projectId ?? undefined,
      workers,
    };
  }

  private validate(): void {
    for (const project of this.projectsById.values()) {
      for (const workerId of project.workerIds ?? []) {
        if (!this.workersById.has(workerId)) {
          throw new Error(`Project '${project.id}' references unknown worker '${workerId}'.`);
        }
      }
      for (const toolContractId of project.toolContractIds ?? []) {
        if (!this.toolContractsById.has(toolContractId)) {
          throw new Error(
            `Project '${project.id}' references unknown tool contract '${toolContractId}'.`,
          );
        }
      }
    }

    for (const worker of this.workersById.values()) {
      for (const toolContractId of worker.toolContractIds ?? []) {
        if (!this.toolContractsById.has(toolContractId)) {
          throw new Error(
            `Worker '${worker.id}' references unknown tool contract '${toolContractId}'.`,
          );
        }
      }
    }

    for (const workflow of this.workflowsById.values()) {
      if (!this.workersById.has(workflow.ownerWorkerId)) {
        throw new Error(
          `Workflow '${workflow.id}' references unknown worker '${workflow.ownerWorkerId}'.`,
        );
      }

      for (const toolContractId of workflow.toolContractIds ?? []) {
        if (!this.toolContractsById.has(toolContractId)) {
          throw new Error(
            `Workflow '${workflow.id}' references unknown tool contract '${toolContractId}'.`,
          );
        }
      }
    }

    for (const intentContract of this.intentContractsById.values()) {
      if (intentContract.route.kind === "workflow") {
        if (!this.workflowsById.has(intentContract.route.targetId)) {
          throw new Error(
            `Intent contract '${intentContract.id}' references unknown workflow '${intentContract.route.targetId}'.`,
          );
        }
        continue;
      }

      if (!this.workersById.has(intentContract.route.targetId)) {
        throw new Error(
          `Intent contract '${intentContract.id}' references unknown worker '${intentContract.route.targetId}'.`,
        );
      }
    }
  }

  private resolveAccessibleWorkerIds(
    agentId: string,
    projectId?: string,
  ): Set<string> {
    const accessible = new Set<string>();
    const agent = this.agentsById.get(agentId);
    if (!agent) return accessible;

    const agentWorkerIds = new Set<string>(agent.orchestration?.workerIds ?? []);
    const ownedWorkerIds = [...this.workersById.values()]
      .filter((worker) => worker.ownerAgentId === agentId)
      .map((worker) => worker.id);
    for (const workerId of ownedWorkerIds) {
      agentWorkerIds.add(workerId);
    }

    const projectWorkerIds = new Set<string>(
      projectId ? this.projectsById.get(projectId)?.workerIds ?? [] : [],
    );

    if (agentWorkerIds.size > 0 && projectWorkerIds.size > 0) {
      for (const workerId of agentWorkerIds) {
        if (projectWorkerIds.has(workerId)) accessible.add(workerId);
      }
      return accessible;
    }

    const source = agentWorkerIds.size > 0 ? agentWorkerIds : projectWorkerIds;
    for (const workerId of source) {
      accessible.add(workerId);
    }
    return accessible;
  }

  private toPlannerWorkflowSummary(workflow: WorkflowConfig): PlannerWorkflowSummary {
    const worker = this.workersById.get(workflow.ownerWorkerId) ?? null;
    const toolContractIds =
      workflow.toolContractIds && workflow.toolContractIds.length > 0
        ? workflow.toolContractIds
        : worker?.toolContractIds ?? [];
    const toolContracts = toolContractIds
      .map((toolContractId) => this.toolContractsById.get(toolContractId))
      .filter((contract): contract is ToolContractConfig => contract !== undefined)
      .map((contract) => this.toPlannerToolContractSummary(contract));

    return {
      id: workflow.id,
      displayName: workflow.displayName,
      description: workflow.description,
      ownerWorkerId: workflow.ownerWorkerId,
      ownerWorkerDisplayName: worker?.displayName,
      mode: workflow.mode,
      status: workflow.status,
      confirmationRequired: workflow.confirmationRequired,
      handler: workflow.handler,
      inputFields: workflow.inputFields ?? [],
      examples: workflow.examples ?? [],
      planningSummary: workflow.planning?.summary,
      planningWhenToUse: workflow.planning?.whenToUse ?? [],
      planningClarifications: workflow.planning?.askForClarificationWhen ?? [],
      toolContracts,
      workerToolsDoc: loadAdjacentToolsDoc(worker?.promptFile),
    };
  }

  private resolveProjectToolContractIds(projectId?: string): Set<string> | null {
    if (!projectId) return null;
    const project = this.projectsById.get(projectId);
    if (!project || !project.toolContractIds || project.toolContractIds.length === 0) {
      return null;
    }
    return new Set(project.toolContractIds);
  }

  private toPlannerToolContractSummary(
    contract: ToolContractConfig,
  ): PlannerToolContractSummary {
    return {
      id: contract.id,
      family: contract.family,
      description: contract.description,
      mode: contract.mode,
      integration: contract.integration,
      inputFields: contract.inputFields ?? [],
      outputFields: contract.outputFields ?? [],
    };
  }

  private toPlannerWorkerSummary(
    worker: WorkerConfig,
    allowedProjectToolContractIds: Set<string> | null,
  ): PlannerWorkerSummary {
    const toolContracts = (worker.toolContractIds ?? [])
      .filter((toolContractId) =>
        allowedProjectToolContractIds ? allowedProjectToolContractIds.has(toolContractId) : true,
      )
      .map((toolContractId) => this.toolContractsById.get(toolContractId))
      .filter((contract): contract is ToolContractConfig => contract !== undefined)
      .map((contract) => this.toPlannerToolContractSummary(contract));

    return {
      id: worker.id,
      type: worker.type,
      displayName: worker.displayName,
      description: worker.description,
      ownerAgentId: worker.ownerAgentId,
      providerDefault: worker.provider.default,
      writeScope: worker.policy?.writeScope,
      confirmBeforeWrite: worker.policy?.confirmBeforeWrite,
      promptText: loadPromptText(worker.promptFile),
      toolContracts,
      workerToolsDoc: loadAdjacentToolsDoc(worker.promptFile),
    };
  }
}

export function loadCapabilityRegistry(explicitConfigDir?: string): CapabilityRegistry {
  const configDir = resolveConfigDir(explicitConfigDir);
  return new CapabilityRegistry({
    agents: loadAgentConfigs(configDir),
    projects: loadProjectConfigs(configDir),
    workers: loadWorkerConfigs(configDir),
    toolContracts: loadToolContractConfigs(configDir),
    workflows: loadWorkflowConfigs(configDir),
    intentContracts: loadIntentContractConfigs(configDir),
  });
}

function loadAdjacentToolsDoc(promptFile: string | undefined): string | undefined {
  if (!promptFile) return undefined;
  const toolsDocPath = path.join(path.dirname(promptFile), "TOOLS.md");
  if (!fs.existsSync(toolsDocPath)) return undefined;
  return fs.readFileSync(toolsDocPath, "utf8");
}

function loadPromptText(promptFile: string | undefined): string | undefined {
  if (!promptFile || !fs.existsSync(promptFile)) return undefined;
  return fs.readFileSync(promptFile, "utf8");
}
