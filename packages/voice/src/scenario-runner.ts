import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  TangoStorage,
  type StoredMessageRecord,
  type TopicRecord,
} from "@tango/core";
import { type VoiceAddressAgent } from "./agent-address-book.js";
import { VoiceTargetDirectory } from "./address-routing.js";
import { parseNaturalTextRoute, type NaturalTextRoute, type NaturalTextSystemCommand } from "./natural-routing.js";
import { ProjectDirectory, type VoiceProject } from "./project-directory.js";
import { buildProjectSessionId, parseProjectSessionId } from "./project-routing.js";
import {
  buildTopicSessionId,
  formatCurrentTopicMessage,
  formatOpenedTopicMessage,
  normalizeTopicSlug,
} from "./topic-routing.js";

export type ScenarioSurface = "text" | "voice";

export interface ScenarioRunnerOptions {
  configDir: string;
  dbPath?: string;
  channelKey?: string;
  baseSessionId?: string;
  routeAgentId?: string;
}

export interface ScenarioTurnResult {
  surface: ScenarioSurface;
  input: string;
  kind: "prompt" | "system";
  sessionId: string;
  targetAgentId: string | null;
  targetAgentDisplayName: string | null;
  replyText: string;
  systemCommandType: NaturalTextSystemCommand["type"] | null;
  topicId: string | null;
  topicTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
  focusedAgentId: string | null;
}

export interface ScenarioStateSnapshot {
  channelKey: string;
  focusedTopic: TopicRecord | null;
  focusedProject: VoiceProject | null;
  textFocusedAgentId: string | null;
  voiceFocusedAgentId: string | null;
}

function createDefaultDbPath(): string {
  return path.join(os.tmpdir(), `tango-scenario-runner-${process.pid}-${randomUUID()}.sqlite`);
}

function formatTopicReply(topic: TopicRecord, project: VoiceProject | null): string {
  return formatCurrentTopicMessage(topic.title, project?.displayName ?? null);
}

export class ScenarioRunner {
  readonly storage: TangoStorage;
  readonly voiceTargets: VoiceTargetDirectory;
  readonly projectDirectory: ProjectDirectory;
  readonly channelKey: string;
  readonly baseSessionId: string;
  readonly routeAgentId: string;
  private readonly focusedAgentIds: Record<ScenarioSurface, string | null> = {
    text: null,
    voice: null,
  };

  constructor(options: ScenarioRunnerOptions) {
    this.storage = new TangoStorage(options.dbPath ?? createDefaultDbPath());
    this.voiceTargets = new VoiceTargetDirectory(options.configDir);
    this.projectDirectory = new ProjectDirectory(options.configDir);
    this.channelKey = options.channelKey?.trim() || "discord:test";
    this.baseSessionId = options.baseSessionId?.trim() || "tango-default";
    this.routeAgentId =
      options.routeAgentId?.trim() ||
      this.voiceTargets.getSystemAgent()?.id ||
      "dispatch";
    this.ensureSession(this.baseSessionId, this.routeAgentId);
  }

  destroy(): void {
    this.storage.close();
  }

  getState(): ScenarioStateSnapshot {
    return {
      channelKey: this.channelKey,
      focusedTopic: this.getFocusedTopic(),
      focusedProject: this.getFocusedProject(),
      textFocusedAgentId: this.focusedAgentIds.text,
      voiceFocusedAgentId: this.focusedAgentIds.voice,
    };
  }

  getMessages(sessionId: string, limit = 100): StoredMessageRecord[] {
    return this.storage.listMessagesForSession(sessionId, limit);
  }

  runTurn(surface: ScenarioSurface, input: string): ScenarioTurnResult {
    const route = parseNaturalTextRoute({
      text: input,
      voiceTargets: this.voiceTargets,
      focusedAgentId: this.focusedAgentIds[surface],
    });

    if (route.systemCommand) {
      return this.handleSystemCommand(surface, input, route);
    }
    return this.handlePrompt(surface, input, route);
  }

  private handlePrompt(
    surface: ScenarioSurface,
    input: string,
    route: NaturalTextRoute,
  ): ScenarioTurnResult {
    const targetAgent = this.resolvePromptAgent(surface, route.addressedAgentId);
    const resolvedTargetAgent = targetAgent ?? this.voiceTargets.resolveDefaultPromptAgent(this.routeAgentId);
    const promptText = route.promptText.trim() || input.trim();
    const resolvedRoute = this.resolvePromptSession(route, resolvedTargetAgent);
    const replyText = `Simulated ${resolvedTargetAgent?.displayName ?? "assistant"} reply to: ${promptText}`;

    this.insertMessage({
      sessionId: resolvedRoute.sessionId,
      agentId: resolvedTargetAgent?.id ?? null,
      surface,
      direction: "inbound",
      content: input,
      metadata: {
        promptText,
        topicId: resolvedRoute.topic?.id ?? null,
        topicTitle: resolvedRoute.topic?.title ?? null,
        projectId: resolvedRoute.project?.id ?? null,
        projectTitle: resolvedRoute.project?.displayName ?? null,
      },
    });
    this.insertMessage({
      sessionId: resolvedRoute.sessionId,
      agentId: resolvedTargetAgent?.id ?? null,
      surface,
      direction: "outbound",
      content: replyText,
      metadata: {
        simulated: true,
        topicId: resolvedRoute.topic?.id ?? null,
        topicTitle: resolvedRoute.topic?.title ?? null,
        projectId: resolvedRoute.project?.id ?? null,
        projectTitle: resolvedRoute.project?.displayName ?? null,
      },
    });

    return {
      surface,
      input,
      kind: "prompt",
      sessionId: resolvedRoute.sessionId,
      targetAgentId: resolvedTargetAgent?.id ?? null,
      targetAgentDisplayName: resolvedTargetAgent?.displayName ?? null,
      replyText,
      systemCommandType: null,
      topicId: resolvedRoute.topic?.id ?? null,
      topicTitle: resolvedRoute.topic?.title ?? null,
      projectId: resolvedRoute.project?.id ?? null,
      projectTitle: resolvedRoute.project?.displayName ?? null,
      focusedAgentId: this.focusedAgentIds[surface],
    };
  }

  private handleSystemCommand(
    surface: ScenarioSurface,
    input: string,
    route: NaturalTextRoute,
  ): ScenarioTurnResult {
    const systemCommand = route.systemCommand!;
    const systemAgent = this.voiceTargets.getSystemAgent();
    let replyText = "Unsupported system command.";

    switch (systemCommand.type) {
      case "status":
        replyText = this.formatStatus(surface);
        break;
      case "focus-agent": {
        const agent = this.voiceTargets.resolveAgentQuery(systemCommand.agentQuery);
        if (!agent) {
          replyText = `I couldn't find an agent named ${systemCommand.agentQuery}.`;
          break;
        }
        this.focusedAgentIds[surface] = agent.id;
        replyText = `Focused on ${agent.displayName}. You can keep talking.`;
        break;
      }
      case "clear-focus": {
        const focusedAgent = this.voiceTargets.getAgent(this.focusedAgentIds[surface]);
        if (!focusedAgent) {
          replyText = "No agent focus is active right now.";
          break;
        }
        this.focusedAgentIds[surface] = null;
        replyText = `Back to ${this.voiceTargets.getSystemAgent()?.displayName ?? "Tango"}.`;
        break;
      }
      case "current-agent": {
        const focusedAgent = this.voiceTargets.getAgent(this.focusedAgentIds[surface]);
        replyText = focusedAgent
          ? `You are focused on ${focusedAgent.displayName}.`
          : `No focused agent. Say ${this.voiceTargets.getSystemAgent()?.displayName ?? "Tango"}, talk to an agent name.`;
        break;
      }
      case "open-topic": {
        let topicProject: VoiceProject | null = null;
        if (systemCommand.projectName) {
          topicProject = this.projectDirectory.resolveProjectQuery(systemCommand.projectName);
          if (!topicProject) {
            replyText = `I couldn't find a project named ${systemCommand.projectName}.`;
            break;
          }
          this.storage.setFocusedProjectForChannel(this.channelKey, topicProject.id);
        }
        const leadAgent =
          (topicProject?.defaultAgentId
            ? this.voiceTargets.getAgent(topicProject.defaultAgentId)
            : null) ??
          this.resolveDefaultTopicLeadAgent(surface, {
            allowFocusedProject: false,
          });
        const topic = this.upsertTopic(systemCommand.topicName, leadAgent, topicProject?.id ?? null, false);
        this.storage.setFocusedTopicForChannel(this.channelKey, topic.id);
        replyText = formatOpenedTopicMessage(topic.title, topicProject?.displayName ?? null);
        break;
      }
      case "move-topic-to-project": {
        const project = this.projectDirectory.resolveProjectQuery(systemCommand.projectName);
        if (!project) {
          replyText = `I couldn't find a project named ${systemCommand.projectName}.`;
          break;
        }
        const existingTopic = systemCommand.topicName
          ? this.getTopicByName(systemCommand.topicName)
          : this.getFocusedTopic();
        if (!existingTopic) {
          replyText = systemCommand.topicName
            ? `I couldn't find a topic named ${systemCommand.topicName}.`
            : "No topic is active right now.";
          break;
        }
        this.storage.setFocusedProjectForChannel(this.channelKey, project.id);
        const leadAgent =
          this.voiceTargets.getAgent(existingTopic.leadAgentId) ??
          this.voiceTargets.getAgent(project.defaultAgentId) ??
          this.resolveDefaultTopicLeadAgent(surface);
        const movedTopic = this.upsertTopic(existingTopic.title, leadAgent, project.id, false);
        this.storage.setFocusedTopicForChannel(this.channelKey, movedTopic.id);
        replyText = `Moved topic ${movedTopic.title} to project ${project.displayName}.`;
        break;
      }
      case "detach-topic-from-project": {
        const existingTopic = systemCommand.topicName
          ? this.getTopicByName(systemCommand.topicName)
          : this.getFocusedTopic();
        if (!existingTopic) {
          replyText = systemCommand.topicName
            ? `I couldn't find a topic named ${systemCommand.topicName}.`
            : "No topic is active right now.";
          break;
        }
        const previousProject = this.projectDirectory.getProject(existingTopic.projectId);
        if (!previousProject && !existingTopic.projectId) {
          this.storage.setFocusedTopicForChannel(this.channelKey, existingTopic.id);
          replyText = `Topic ${existingTopic.title} is already standalone.`;
          break;
        }
        if (existingTopic.projectId) {
          this.storage.setFocusedProjectForChannel(this.channelKey, existingTopic.projectId);
        }
        const leadAgent =
          this.voiceTargets.getAgent(existingTopic.leadAgentId) ??
          this.resolveDefaultTopicLeadAgent(surface, { allowFocusedProject: false });
        const detachedTopic = this.upsertTopic(existingTopic.title, leadAgent, null, false);
        this.storage.setFocusedTopicForChannel(this.channelKey, detachedTopic.id);
        replyText = `Detached topic ${detachedTopic.title} from project ${previousProject?.displayName ?? existingTopic.projectId}. It is now standalone.`;
        break;
      }
      case "current-topic": {
        const topic = this.getFocusedTopic();
        replyText = topic
          ? formatTopicReply(topic, this.resolveProjectForTopic(topic))
          : "No topic is active right now.";
        break;
      }
      case "clear-topic": {
        const topic = this.getFocusedTopic();
        if (!topic) {
          replyText = "No topic is active right now.";
          break;
        }
        this.storage.setFocusedTopicForChannel(this.channelKey, null);
        const resumeProject = this.getFocusedProject() ?? this.getRoutedProject();
        replyText = resumeProject
          ? `Left ${topic.projectId ? `topic ${topic.title}` : `standalone topic ${topic.title}`}. Project ${resumeProject.displayName} is still active.`
          : `Left ${topic.projectId ? `topic ${topic.title}` : `standalone topic ${topic.title}`}.`;
        break;
      }
      case "open-project": {
        const project = this.projectDirectory.resolveProjectQuery(systemCommand.projectName);
        if (!project) {
          replyText = `I couldn't find a project named ${systemCommand.projectName}.`;
          break;
        }
        const clearedTopic = this.getFocusedTopic();
        if (clearedTopic) {
          this.storage.setFocusedTopicForChannel(this.channelKey, null);
        }
        this.storage.setFocusedProjectForChannel(this.channelKey, project.id);
        replyText = clearedTopic
          ? `Opened project ${project.displayName}. Cleared topic ${clearedTopic.title}.`
          : `Opened project ${project.displayName}. You can keep talking.`;
        break;
      }
      case "current-project": {
        const topic = this.getFocusedTopic();
        const activeProject = this.resolveActiveProject(topic);
        if (activeProject) {
          replyText = `You are in project ${activeProject.displayName}.`;
          break;
        }
        const focusedProject = this.getFocusedProject();
        const routedProject = this.getRoutedProject();
        const resumeProject = focusedProject ?? routedProject;
        if (topic && resumeProject) {
          replyText = focusedProject
            ? `Current topic ${topic.title} is standalone. Focused project ${resumeProject.displayName} will resume when you leave this topic.`
            : `Current topic ${topic.title} is standalone. Project ${resumeProject.displayName} will resume when you leave this topic.`;
          break;
        }
        replyText = "No project is active right now.";
        break;
      }
      case "clear-project": {
        const topic = this.getFocusedTopic();
        const focusedProject = this.getFocusedProject();
        const routedProject = this.getRoutedProject();
        const activeProject = this.resolveActiveProject(topic) ?? focusedProject;
        if (!activeProject) {
          replyText = "No project is active right now.";
          break;
        }
        if (!focusedProject && routedProject?.id === activeProject.id) {
          replyText = topic
            ? `Channel is routed to project ${routedProject.displayName}. Clear the topic separately or open another project to override it.`
            : `Channel is routed to project ${routedProject.displayName}. Open another project to override it.`;
          break;
        }
        this.storage.setFocusedProjectForChannel(this.channelKey, null);
        if (topic?.projectId === activeProject.id) {
          this.storage.setFocusedTopicForChannel(this.channelKey, null);
          replyText =
            routedProject && routedProject.id !== activeProject.id
              ? `Left project ${activeProject.displayName}. Cleared topic ${topic.title}. Channel returned to project ${routedProject.displayName}.`
              : `Left project ${activeProject.displayName}. Cleared topic ${topic.title}.`;
          break;
        }
        replyText = topic
          ? routedProject && routedProject.id !== activeProject.id
            ? `Cleared focused project ${activeProject.displayName}. Current topic ${topic.title} remains ${topic.projectId ? "attached to that project until you move it" : "standalone"}. Channel returned to project ${routedProject.displayName}.`
            : `Cleared focused project ${activeProject.displayName}. Current topic ${topic.title} remains ${topic.projectId ? "attached to that project until you move it" : "standalone"}.`
          : routedProject && routedProject.id !== activeProject.id
            ? `Left project ${activeProject.displayName}. Channel returned to project ${routedProject.displayName}.`
            : `Left project ${activeProject.displayName}.`;
        break;
      }
    }

    const resolvedSessionId = this.resolveActiveSession().sessionId;
    this.insertMessage({
      sessionId: resolvedSessionId,
      agentId: systemAgent?.id ?? this.routeAgentId,
      surface,
      direction: "inbound",
      content: input,
      metadata: {
        localSystemCommand: true,
        commandType: systemCommand.type,
      },
    });
    this.insertMessage({
      sessionId: resolvedSessionId,
      agentId: systemAgent?.id ?? this.routeAgentId,
      surface,
      direction: "system",
      content: replyText,
      metadata: {
        localSystemCommand: true,
        commandType: systemCommand.type,
      },
    });

    const topic = this.getFocusedTopic();
    const project = this.resolveActiveProject(topic);

    return {
      surface,
      input,
      kind: "system",
      sessionId: resolvedSessionId,
      targetAgentId: systemAgent?.id ?? this.routeAgentId,
      targetAgentDisplayName: systemAgent?.displayName ?? "Tango",
      replyText,
      systemCommandType: systemCommand.type,
      topicId: topic?.id ?? null,
      topicTitle: topic?.title ?? null,
      projectId: project?.id ?? null,
      projectTitle: project?.displayName ?? null,
      focusedAgentId: this.focusedAgentIds[surface],
    };
  }

  private resolvePromptSession(
    route: NaturalTextRoute,
    targetAgent: VoiceAddressAgent | null,
  ): {
    sessionId: string;
    topic: TopicRecord | null;
    project: VoiceProject | null;
  } {
    const topicName = route.topicName?.trim();
    if (topicName) {
      const topic = this.upsertTopic(topicName, targetAgent, null, true);
      this.storage.setFocusedTopicForChannel(this.channelKey, topic.id);
      return {
        sessionId: buildTopicSessionId(topic.id),
        topic,
        project: this.resolveProjectForTopic(topic),
      };
    }

    return this.resolveActiveSession();
  }

  private resolveActiveSession(): {
    sessionId: string;
    topic: TopicRecord | null;
    project: VoiceProject | null;
  } {
    const topic = this.getFocusedTopic();
    const project = this.resolveActiveProject(topic);
    if (topic) {
      return {
        sessionId: buildTopicSessionId(topic.id),
        topic,
        project,
      };
    }
    if (project) {
      return {
        sessionId: buildProjectSessionId(project.id),
        topic: null,
        project,
      };
    }
    return {
      sessionId: this.baseSessionId,
      topic: null,
      project: null,
    };
  }

  private resolvePromptAgent(
    surface: ScenarioSurface,
    explicitAgentId: string | null,
  ): VoiceAddressAgent | null {
    if (explicitAgentId) {
      const explicit = this.voiceTargets.getAgent(explicitAgentId);
      if (explicit && !this.voiceTargets.isSystemAgent(explicit.id)) {
        return explicit;
      }
    }

    const focusedAgent = this.voiceTargets.getAgent(this.focusedAgentIds[surface]);
    if (focusedAgent && !this.voiceTargets.isSystemAgent(focusedAgent.id)) {
      return focusedAgent;
    }

    const focusedTopic = this.getFocusedTopic();
    const topicLeadAgent = this.voiceTargets.getAgent(focusedTopic?.leadAgentId);
    if (topicLeadAgent && !this.voiceTargets.isSystemAgent(topicLeadAgent.id)) {
      return topicLeadAgent;
    }

    const activeProject = this.resolveActiveProject(focusedTopic);
    const projectDefaultAgent = this.voiceTargets.getAgent(activeProject?.defaultAgentId);
    if (projectDefaultAgent && !this.voiceTargets.isSystemAgent(projectDefaultAgent.id)) {
      return projectDefaultAgent;
    }

    return this.voiceTargets.resolveDefaultPromptAgent(this.routeAgentId);
  }

  private resolveDefaultTopicLeadAgent(
    surface: ScenarioSurface,
    options?: { allowFocusedProject?: boolean },
  ): VoiceAddressAgent | null {
    const focusedAgent = this.voiceTargets.getAgent(this.focusedAgentIds[surface]);
    if (focusedAgent && !this.voiceTargets.isSystemAgent(focusedAgent.id)) {
      return focusedAgent;
    }

    const activeProject =
      options?.allowFocusedProject === false
        ? null
        : this.resolveActiveProject(this.getFocusedTopic());
    const projectDefaultAgent = this.voiceTargets.getAgent(activeProject?.defaultAgentId);
    if (projectDefaultAgent && !this.voiceTargets.isSystemAgent(projectDefaultAgent.id)) {
      return projectDefaultAgent;
    }

    return this.voiceTargets.resolveDefaultPromptAgent(this.routeAgentId);
  }

  private upsertTopic(
    topicName: string,
    leadAgent: VoiceAddressAgent | null,
    projectId: string | null,
    preserveProjectId: boolean,
  ): TopicRecord {
    const title = topicName.trim().replace(/\s+/g, " ");
    const slug = normalizeTopicSlug(title);
    if (!slug) {
      throw new Error("Topic name must include letters or numbers.");
    }
    return this.storage.upsertTopic({
      channelKey: this.channelKey,
      slug,
      title,
      leadAgentId: leadAgent?.id ?? null,
      projectId,
      preserveProjectId,
    });
  }

  private getTopicByName(topicName: string): TopicRecord | null {
    const slug = normalizeTopicSlug(topicName);
    if (!slug) return null;
    return this.storage.getTopicByChannelAndSlug(this.channelKey, slug);
  }

  private getFocusedTopic(): TopicRecord | null {
    return this.storage.getFocusedTopicForChannel(this.channelKey);
  }

  private getFocusedProject(): VoiceProject | null {
    return this.projectDirectory.getProject(this.storage.getFocusedProjectIdForChannel(this.channelKey));
  }

  private getRoutedProject(): VoiceProject | null {
    return this.projectDirectory.getProject(parseProjectSessionId(this.baseSessionId));
  }

  private resolveProjectForTopic(topic: TopicRecord | null): VoiceProject | null {
    return this.projectDirectory.getProject(topic?.projectId ?? null);
  }

  private resolveActiveProject(topic: TopicRecord | null): VoiceProject | null {
    if (topic) {
      return this.resolveProjectForTopic(topic);
    }
    return this.getFocusedProject() ?? this.getRoutedProject();
  }

  private insertMessage(input: {
    sessionId: string;
    agentId: string | null;
    surface: ScenarioSurface;
    direction: "inbound" | "outbound" | "system";
    content: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.ensureSession(input.sessionId, input.agentId ?? this.routeAgentId);
    this.storage.insertMessage({
      sessionId: input.sessionId,
      agentId: input.agentId,
      direction: input.direction,
      source: input.surface === "text" ? "discord" : "tango",
      visibility: "public",
      content: input.content,
      metadata: {
        surface: input.surface,
        ...input.metadata,
      },
    });
  }

  private ensureSession(sessionId: string, agentId: string): void {
    this.storage.upsertSession({
      id: sessionId,
      type: sessionId.startsWith("project:")
        ? "project"
        : "persistent",
      agent: agentId,
      channels: [this.channelKey],
    });
  }

  private formatStatus(surface: ScenarioSurface): string {
    const parts: string[] = [];
    const focusedAgent = this.voiceTargets.getAgent(this.focusedAgentIds[surface]);
    if (focusedAgent) {
      parts.push(`Focused agent: ${focusedAgent.displayName}.`);
    } else {
      parts.push("No focused agent.");
    }

    const topic = this.getFocusedTopic();
    if (topic) {
      parts.push(formatTopicReply(topic, this.resolveProjectForTopic(topic)));
    } else {
      parts.push("No topic is active right now.");
    }

    const project = this.resolveActiveProject(topic);
    if (project) {
      parts.push(`Current project: ${project.displayName}.`);
    } else {
      const focusedProject = this.getFocusedProject();
      if (focusedProject) {
        parts.push(`Focused project: ${focusedProject.displayName}.`);
      } else {
        parts.push("No project is active right now.");
      }
    }

    return parts.join(" ");
  }
}
