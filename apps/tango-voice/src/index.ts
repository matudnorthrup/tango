import { config } from './config.js';
import { createClient } from './discord/client.js';
import { joinChannel, leaveChannel, getConnection, setConnection } from './discord/voice-connection.js';
import { VoicePipeline } from './pipeline/voice-pipeline.js';
import { clearConversation } from './services/claude.js';
import { ChannelRouter } from './services/channel-router.js';
import { initVoiceSettings, getVoiceSettings, setSilenceDuration, setSpeechThreshold, setMinSpeechDuration, setGatedMode, setEndpointingMode, resolveNoiseLevel, getNoisePresetNames } from './services/voice-settings.js';
import { getTtsBackend, setTtsBackend, getAvailableTtsBackends } from './services/tts.js';
import { QueueState, getVoiceModeLabel, normalizeVoiceMode, type VoiceMode } from './services/queue-state.js';
import { InboxClient } from './services/inbox-client.js';
import { DependencyMonitor, type DependencyStatus } from './services/dependency-monitor.js';
import { HealthMonitor } from './services/health-monitor.js';
import { getPreferredSystemWakeName } from './services/voice-targets.js';
import { VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { ChannelType, TextChannel, VoiceState, SlashCommandBuilder, REST, Routes, ChatInputCommandInteraction, GuildMember, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuInteraction, ButtonInteraction } from 'discord.js';

const VOICE_APP_NAME = 'Tango Voice';
const PRIMARY_SWITCH_COMMAND = 'tango';
const PRIMARY_SETTINGS_COMMAND = 'tango-settings';
const LEGACY_SWITCH_COMMAND = 'watson';
const LEGACY_SETTINGS_COMMAND = 'watson-settings';
const SWITCH_COMMAND_NAMES = new Set([PRIMARY_SWITCH_COMMAND, LEGACY_SWITCH_COMMAND]);
const SETTINGS_COMMAND_NAMES = new Set([PRIMARY_SETTINGS_COMMAND, LEGACY_SETTINGS_COMMAND]);

console.log(`${VOICE_APP_NAME} starting... (system wake: ${getPreferredSystemWakeName()})`);

initVoiceSettings({
  silenceDurationMs: config.silenceDurationMs,
  speechThreshold: config.speechThreshold,
  minSpeechDurationMs: config.minSpeechDurationMs,
  audioProcessing: config.audioProcessing,
  endpointingMode: config.endpointingMode,
  indicateCloseWords: config.indicateCloseWords,
  indicateTimeoutMs: config.indicateTimeoutMs,
  sttStreamingEnabled: config.sttStreamingEnabled,
  sttStreamingChunkMs: config.sttStreamingChunkMs,
  sttStreamingMinChunkMs: config.sttStreamingMinChunkMs,
  sttStreamingOverlapMs: config.sttStreamingOverlapMs,
  sttStreamingMaxChunks: config.sttStreamingMaxChunks,
  vadPositiveSpeechThreshold: config.vadPositiveSpeechThreshold,
  vadNegativeSpeechThreshold: config.vadNegativeSpeechThreshold,
  vadFrameSamples: config.vadFrameSamples,
  localStreamIdleMs: config.localStreamIdleMs,
});

const client = createClient();
let pipeline: VoicePipeline | null = null;
let router: ChannelRouter | null = null;
let leaveTimeout: ReturnType<typeof setTimeout> | null = null;
let queueState: QueueState | null = null;
let dependencyMonitor: DependencyMonitor | null = null;
let healthMonitor: HealthMonitor | null = null;

// --- Text command handlers ---

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user?.id) return;

  if (message.author.bot) return;

  if (message.content === '~join') {
    await handleJoin(message.guild!.id, message);
  } else if (message.content === '~leave') {
    handleLeave();
    await message.reply('Left voice channel.');
  } else if (message.content === '~clear') {
    clearConversation(message.author.id);
    if (router) {
      router.clearActiveHistory();
    }
    await message.reply('Conversation cleared.');
  } else if (message.content === '~channels') {
    if (!router) {
      await message.reply('Not connected to voice. Use `~join` first.');
      return;
    }
    const list = router.listChannels();
    const lines = list.map((ch) =>
      `${ch.active ? '> ' : '  '} **${ch.name}** — ${ch.displayName}${ch.active ? ' (active)' : ''}`,
    );
    await message.reply(`Available channels:\n${lines.join('\n')}`);
  } else if (message.content.startsWith('~switch ')) {
    if (!router || !pipeline) {
      await message.reply('Not connected to voice. Use `~join` first.');
      return;
    }
    const name = message.content.slice('~switch '.length).trim();
    const result = await router.switchTo(name.toLowerCase());
    if (!result.success) {
      await message.reply(result.error!);
      return;
    }
    await pipeline.onChannelSwitch();
    const label = result.displayName || name;
    await message.reply(`Switched to **${label}**. Loaded ${result.historyCount} history messages.`);
  } else if (message.content === '~default') {
    if (!router || !pipeline) {
      await message.reply('Not connected to voice. Use `~join` first.');
      return;
    }
    const result = await router.switchToDefault();
    await pipeline.onChannelSwitch();
    await message.reply(`Switched back to **default** channel. Loaded ${result.historyCount} history messages.`);
  } else if (message.content === '~voice') {
    const s = getVoiceSettings();
    const modeLabel = getVoiceModeLabel(queueState?.getMode());
    await message.reply(
      `**Voice settings:**\n` +
      `  Voice mode: **${modeLabel}**\n` +
      `  Audio processing: **${s.audioProcessing}**\n` +
      `  Endpointing: **${s.endpointingMode}**\n` +
      `  STT streaming: **${s.sttStreamingEnabled ? `on (${s.sttStreamingChunkMs}ms chunks)` : 'off'}**\n` +
      `  Silence delay: **${s.silenceDurationMs}ms**\n` +
      `  Noise threshold: **${s.speechThreshold}** (higher = ignores more noise)\n` +
      `  Min speech duration: **${s.minSpeechDurationMs}ms**`,
    );
  } else if (message.content.startsWith('~delay ')) {
    const val = parseInt(message.content.slice('~delay '.length).trim(), 10);
    if (isNaN(val) || val < 500 || val > 10000) {
      await message.reply('Usage: `~delay <500-10000>` (milliseconds). Example: `~delay 3000`');
      return;
    }
    setSilenceDuration(val);
    await message.reply(`Silence delay set to **${val}ms**. Takes effect on next utterance.`);
  } else if (message.content.startsWith('~noise ')) {
    const input = message.content.slice('~noise '.length).trim();
    const result = resolveNoiseLevel(input);
    if (!result) {
      const presets = getNoisePresetNames().join(', ');
      await message.reply(`Usage: \`~noise <${presets}>\` or \`~noise <number>\`. Example: \`~noise high\``);
      return;
    }
    setSpeechThreshold(result.threshold);
    await message.reply(`Noise threshold set to **${result.label}** (${result.threshold}). Higher = ignores more background noise.`);
  } else if (message.content.startsWith('~mode ')) {
    const rawMode = message.content.slice('~mode '.length).trim().toLowerCase();
    if (!['focus', 'background', 'wait', 'queue', 'inbox', 'ask'].includes(rawMode)) {
      await message.reply('Usage: `~mode <focus|background>`');
      return;
    }
    if (!queueState) {
      queueState = new QueueState();
    }
    const mode = normalizeVoiceMode(rawMode);
    queueState.setMode(mode as VoiceMode);
    await message.reply(`Voice mode set to **${getVoiceModeLabel(mode)}**.`);
  } else if (message.content === '~queue') {
    const modeLabel = getVoiceModeLabel(queueState?.getMode());
    await message.reply(`**Voice mode:** ${modeLabel}\nQueue state is now managed by the unified Discord inbox.`);
  } else if (message.content === '~health') {
    const status = dependencyMonitor
      ? await dependencyMonitor.checkOnce()
      : { whisperUp: false, ttsUp: false };
    const ttsLabel = config.ttsBackend === 'kokoro'
      ? 'Kokoro'
      : config.ttsBackend === 'chatterbox'
        ? 'Chatterbox'
        : 'TTS backend';

    const lines: string[] = [];

    // Pipeline snapshot
    if (pipeline) {
      const snap = pipeline.getHealthSnapshot();
      const notify = pipeline.getIdleNotificationDiagnostics(3);
      const uptimeMin = Math.floor(snap.uptime / 60_000);
      lines.push(`**Pipeline:** ${snap.pipelineState} (${Math.round(snap.pipelineStateAge / 1000)}s)`);
      lines.push(`**Uptime:** ${uptimeMin}m`);
      lines.push(`**Mode:** ${getVoiceModeLabel(snap.mode)}`);
      if (snap.activeChannel) lines.push(`**Channel:** ${snap.activeChannel}`);
      lines.push(`**Queue:** ${snap.queueReady} ready, ${snap.queuePending} pending`);
      lines.push(`**Tango bridge:** ${snap.tangoBridgeConfigured ? 'configured' : 'disabled'}`);
      lines.push(
        `**Notifications:** queue=${snap.idleNotificationQueueDepth}, processing=${snap.idleNotificationProcessing ? 'yes' : 'no'}, in-flight=${snap.idleNotificationInFlight ? 'yes' : 'no'}`,
      );
      if (notify.recentEvents.length > 0) {
        const eventSummary = notify.recentEvents
          .map((event) => {
            const ageSec = Math.max(0, Math.round((Date.now() - event.at) / 1000));
            const reason = event.reason ? ` (${event.reason})` : '';
            return `${event.stage}:${event.kind}${reason} ${ageSec}s ago`;
          })
          .join(' | ');
        lines.push(`**Notification events:** ${eventSummary}`);
      }
    }

    lines.push(`**STT (Whisper):** ${status.whisperUp ? 'up' : 'down'}`);
    lines.push(`**TTS (${ttsLabel}):** ${status.ttsUp ? 'up' : 'down'}`);

    // Counters
    if (pipeline) {
      const c = pipeline.getCounters();
      lines.push('');
      lines.push(`**Counters:**`);
      lines.push(`  Utterances: ${c.utterancesProcessed} | Commands: ${c.commandsRecognized} | LLM: ${c.llmDispatches}`);
      lines.push(`  Errors: ${c.errors} | STT fail: ${c.sttFailures} | TTS fail: ${c.ttsFailures}`);
      lines.push(`  Invariant violations: ${c.invariantViolations} | Stall watchdog: ${c.stallWatchdogFires}`);
      lines.push(
        `  Notify lifecycle: enqueued=${c.idleNotificationsEnqueued} | deduped=${c.idleNotificationsDeduped} | deferred=${c.idleNotificationsDeferred} | dropped=${c.idleNotificationsDropped} | delivered=${c.idleNotificationsDelivered}`,
      );
    }

    await message.reply(lines.join('\n'));
  }
});

// --- Voice state update: auto-join/leave ---

client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
  const targetChannelId = config.discordVoiceChannelId;

  // User joined the target voice channel
  if (newState.channelId === targetChannelId && oldState.channelId !== targetChannelId) {
    if (!newState.member?.user.bot) {
      // Cancel any pending leave timeout
      if (leaveTimeout) {
        clearTimeout(leaveTimeout);
        leaveTimeout = null;
      }

      // Auto-join if not already connected
      if (!getConnection()) {
        console.log(`User ${newState.member?.user.username} joined, auto-joining voice channel`);
        handleJoin(newState.guild.id).catch((err) => {
          console.error('Auto-join failed:', err.message);
        });
      }
    }
  }

  // User left the target voice channel
  if (oldState.channelId === targetChannelId && newState.channelId !== targetChannelId) {
    if (!oldState.member?.user.bot) {
      // Check if any humans remain in the channel
      const channel = oldState.guild.channels.cache.get(targetChannelId);
      if (channel && channel.type === ChannelType.GuildVoice) {
        const humans = channel.members.filter((m) => !m.user.bot);
        if (humans.size === 0) {
          console.log('No humans left in voice channel, leaving in 30s...');
          leaveTimeout = setTimeout(() => {
            // Double check no one rejoined
            const ch = oldState.guild.channels.cache.get(targetChannelId);
            if (ch && ch.type === ChannelType.GuildVoice) {
              const stillHumans = ch.members.filter((m) => !m.user.bot);
              if (stillHumans.size === 0) {
                handleLeave();
              }
            }
            leaveTimeout = null;
          }, 30_000);
        }
      }
    }
  }
});

// --- Core join/leave logic ---

async function handleJoin(guildId: string, message?: any): Promise<void> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.error('Guild not found');
    return;
  }

  try {
    const connection = await joinChannel(
      config.discordVoiceChannelId,
      guildId,
      guild.voiceAdapterCreator,
    );

    // Catch voice connection errors to prevent unhandled 'error' events from crashing the process.
    // Common cause: transient Discord voice server errors (e.g. 521 from Cloudflare).
    // After logging, the connection will typically transition to Disconnected status,
    // which the handler below will pick up for reconnection.
    connection.on('error', (err: Error) => {
      console.error(`Voice connection error: ${err.message}`);
    });

    // Set up reconnection handling
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Try to reconnect within 5s
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Seems to be reconnecting
      } catch {
        // Disconnected for real — attempt auto-rejoin
        console.log('Voice connection lost, attempting auto-rejoin...');
        handleLeave();
        try {
          await handleJoin(guildId);
          console.log('Auto-rejoin succeeded');
        } catch (rejoinErr: any) {
          console.error(`Auto-rejoin failed: ${rejoinErr.message}`);
        }
      }
    });

    // Find log channel if configured
    let logChannel: TextChannel | undefined;
    if (config.logChannelId) {
      const ch = guild.channels.cache.get(config.logChannelId);
      if (ch && ch.type === ChannelType.GuildText) {
        logChannel = ch as TextChannel;
      }
    }

    // Stop existing pipeline
    if (pipeline) {
      pipeline.stop();
    }
    if (router) {
      router.destroy();
    }

    pipeline = new VoicePipeline(connection, logChannel, {
      onDecoderCorruption: () => {
        void (async () => {
          console.log('Decoder corruption detected, auto-rejoining voice channel...');
          handleLeave();
          await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
          try {
            await handleJoin(guildId);
            console.log('Auto-rejoin succeeded');
          } catch (rejoinErr: any) {
            console.error(`Auto-rejoin failed: ${rejoinErr.message}`);
          }
        })();
      },
    });
    router = new ChannelRouter(guild);
    void router.refreshAliasCache().catch((err: any) => {
      console.warn(`Alias cache refresh failed: ${err.message}`);
    });
    pipeline.setRouter(router);
    await pipeline.restoreProjectChannelSurface();

    // Wire queue state (mode-only persistence)
    if (!queueState) {
      queueState = new QueueState();
    }
    pipeline.setQueueState(queueState);

    // Wire unified inbox client (Discord-anchored watermarks) when voice bridge URL is configured
    if (config.tangoVoiceTurnUrl) {
      const bridgeBaseUrl = new URL(config.tangoVoiceTurnUrl).origin;
      const inboxClient = new InboxClient({
        baseUrl: bridgeBaseUrl,
        apiKey: config.tangoVoiceApiKey || undefined,
      });
      pipeline.setInboxClient(inboxClient);
      console.log(`InboxClient: configured at ${bridgeBaseUrl}/voice/inbox`);
    }

    pipeline.start();

    if (dependencyMonitor) {
      dependencyMonitor.stop();
      dependencyMonitor = null;
    }
    dependencyMonitor = new DependencyMonitor((status: DependencyStatus, previous: DependencyStatus | null) => {
      const whisperChanged = !previous || previous.whisperUp !== status.whisperUp;
      const ttsChanged = !previous || previous.ttsUp !== status.ttsUp;

      if (whisperChanged) {
        if (status.whisperUp) {
          console.log('Dependency health: Whisper is reachable');
        } else {
          console.warn('Dependency health: Whisper is unreachable');
          pipeline?.notifyDependencyIssue('stt', 'Speech recognition is unavailable right now.');
        }
      }

      if (ttsChanged) {
        if (status.ttsUp) {
          console.log('Dependency health: TTS backend is reachable');
        } else {
          console.warn('Dependency health: TTS backend is unreachable');
          pipeline?.notifyDependencyIssue('tts', 'Voice output is unavailable right now.');
        }
      }
    });
    dependencyMonitor.start();

    // Wire health monitor
    if (healthMonitor) {
      healthMonitor.stop();
      healthMonitor = null;
    }
    healthMonitor = new HealthMonitor({
      getSnapshot: () => {
        const snap = pipeline!.getHealthSnapshot();
        const depStatus = dependencyMonitor?.getLastStatus();
        if (depStatus) {
          snap.dependencies.whisper = depStatus.whisperUp ? 'up' : 'down';
          snap.dependencies.tts = depStatus.ttsUp ? 'up' : 'down';
        }
        return snap;
      },
      logChannel: logChannel ?? null,
    });
    healthMonitor.start();

    if (message) {
      await message.reply('Joined voice channel. Listening...');
    }
  } catch (error: any) {
    console.error('Failed to join:', error.message);
    if (message) {
      await message.reply(`Failed to join: ${error.message}`);
    }
  }
}

function handleLeave(): void {
  if (healthMonitor) {
    healthMonitor.stop();
    healthMonitor = null;
  }
  if (dependencyMonitor) {
    dependencyMonitor.stop();
    dependencyMonitor = null;
  }
  if (pipeline) {
    pipeline.stop();
    pipeline = null;
  }
  router = null;
  leaveChannel();
}

// --- Settings panel builder ---

function buildSettingsPanel(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<any>[] } {
  const s = getVoiceSettings();
  const systemWakeName = getPreferredSystemWakeName();
  const currentMode = normalizeVoiceMode(queueState?.getMode());
  const modeLabel = getVoiceModeLabel(currentMode);
  const ttsBackend = getTtsBackend();
  const ttsLabel: Record<string, string> = { elevenlabs: 'ElevenLabs', kokoro: 'Kokoro', chatterbox: 'Chatterbox' };

  // Determine noise preset label
  const presetMap: Record<number, string> = { 300: 'Low', 500: 'Medium', 800: 'High' };
  const noiseLabel = presetMap[s.speechThreshold] ?? 'Custom';

  const embed = new EmbedBuilder()
    .setTitle('Voice Settings')
    .addFields(
      { name: `Voice Mode — ${modeLabel}`, value: '**Focus:** answer inline and keep the conversation in context. **Background:** dispatch and let you keep moving.', inline: false },
      { name: `Gated — ${s.gated ? 'ON' : 'OFF'}  ·  TTS — ${ttsLabel[ttsBackend] ?? ttsBackend}`, value: 'Gated requires wake word for each utterance. TTS selects the speech engine.', inline: false },
      { name: `Audio Processing — ${s.audioProcessing}`, value: s.audioProcessing === 'local' ? 'Manual stream control + local Silero VAD endpointing.' : 'Discord speaking endpointing + RMS post-filter.', inline: false },
      {
        name: `Endpointing — ${s.endpointingMode}`,
        value: s.endpointingMode === 'indicate'
          ? `Manual close command mode (${s.indicateCloseWords.map((c) => `${systemWakeName}, ${c}`).join(' · ')}).`
          : 'Process each VAD segment after silence endpointing.',
        inline: false,
      },
      {
        name: `STT Streaming — ${s.sttStreamingEnabled ? 'ON' : 'OFF'}`,
        value: s.sttStreamingEnabled
          ? `Chunk ${s.sttStreamingChunkMs}ms · overlap ${s.sttStreamingOverlapMs}ms · max ${s.sttStreamingMaxChunks} chunks`
          : 'Disabled (batch transcription only).',
        inline: false,
      },
      { name: `Noise Threshold — ${s.speechThreshold} (${noiseLabel})`, value: 'How loud audio must be to count as speech.', inline: false },
      { name: `Silence Delay — ${s.silenceDurationMs}ms  ·  Min Speech — ${s.minSpeechDurationMs}ms`, value: 'Silence delay: pause before processing. Min speech: shortest accepted utterance.', inline: false },
    );

  // Row 1: Voice Mode select
  const modeRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mode-select')
      .setPlaceholder('Voice mode')
      .addOptions(
        { label: 'Focus', description: 'Answer inline and keep follow-ups in context', value: 'wait', default: currentMode === 'wait' },
        { label: 'Background', description: 'Dispatch responses for later review', value: 'queue', default: currentMode === 'queue' },
      ),
  );

  // Row 2: Noise threshold select
  const noiseRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('noise-select')
      .setPlaceholder('Noise threshold')
      .addOptions(
        { label: 'Low (300)', description: 'Quiet room, picks up soft speech', value: '300', default: s.speechThreshold === 300 },
        { label: 'Medium (500)', description: 'Some background noise', value: '500', default: s.speechThreshold === 500 },
        { label: 'High (800)', description: 'Noisy environment, ignores more', value: '800', default: s.speechThreshold === 800 },
      ),
  );

  // Row 3: Silence delay buttons
  const delayRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('label-delay').setLabel('Silence Delay').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('delay-minus').setLabel('-500ms').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('delay-1000').setLabel('1000').setStyle(s.silenceDurationMs === 1000 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('delay-1500').setLabel('1500').setStyle(s.silenceDurationMs === 1500 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('delay-plus').setLabel('+500ms').setStyle(ButtonStyle.Secondary),
  );

  // Row 4: Min speech buttons
  const minSpeechRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('label-minspeech').setLabel('Min Speech').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('minspeech-minus').setLabel('-100ms').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('minspeech-200').setLabel('200').setStyle(s.minSpeechDurationMs === 200 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('minspeech-300').setLabel('300').setStyle(s.minSpeechDurationMs === 300 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('minspeech-plus').setLabel('+100ms').setStyle(ButtonStyle.Secondary),
  );

  // Row 5: Gated toggle + TTS backend buttons
  const availableTts = getAvailableTtsBackends();
  const toggleRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('endpoint-toggle')
      .setLabel(s.endpointingMode === 'indicate' ? '🖐️ End: Manual' : '⏱️ End: Silence')
      .setStyle(s.endpointingMode === 'indicate' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('gated-toggle')
      .setLabel(s.gated ? '🔒 Gated: ON' : '🔓 Gated: OFF')
      .setStyle(s.gated ? ButtonStyle.Success : ButtonStyle.Secondary),
    ...availableTts.map((b) =>
      new ButtonBuilder()
        .setCustomId(`tts-${b}`)
        .setLabel(ttsLabel[b] ?? b)
        .setStyle(b === ttsBackend ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  return { embeds: [embed], components: [modeRow, noiseRow, delayRow, minSpeechRow, toggleRow] };
}

// --- Slash command handler ---

client.on('interactionCreate', async (interaction) => {
  // --- Component interactions (buttons / select menus) ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'noise-select') {
    const value = parseInt(interaction.values[0], 10);
    setSpeechThreshold(value);
    await interaction.update(buildSettingsPanel());
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'mode-select') {
    const mode = normalizeVoiceMode(interaction.values[0]);
    if (!queueState) queueState = new QueueState();
    queueState.setMode(mode);
    await interaction.update(buildSettingsPanel());
    return;
  }

  if (interaction.isButton() && interaction.customId === 'gated-toggle') {
    const s = getVoiceSettings();
    setGatedMode(!s.gated);
    await interaction.update(buildSettingsPanel());
    return;
  }

  if (interaction.isButton() && interaction.customId === 'endpoint-toggle') {
    const s = getVoiceSettings();
    setEndpointingMode(s.endpointingMode === 'indicate' ? 'silence' : 'indicate');
    await interaction.update(buildSettingsPanel());
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('tts-')) {
    const backend = interaction.customId.slice('tts-'.length) as 'elevenlabs' | 'kokoro' | 'chatterbox';
    setTtsBackend(backend);
    await interaction.update(buildSettingsPanel());
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('delay-')) {
    const s = getVoiceSettings();
    let newDelay: number;

    if (interaction.customId === 'delay-minus') {
      newDelay = Math.max(500, s.silenceDurationMs - 500);
    } else if (interaction.customId === 'delay-plus') {
      newDelay = Math.min(10000, s.silenceDurationMs + 500);
    } else {
      newDelay = parseInt(interaction.customId.slice('delay-'.length), 10);
    }

    setSilenceDuration(newDelay);
    await interaction.update(buildSettingsPanel());
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('minspeech-')) {
    const s = getVoiceSettings();
    let newVal: number;

    if (interaction.customId === 'minspeech-minus') {
      newVal = Math.max(100, s.minSpeechDurationMs - 100);
    } else if (interaction.customId === 'minspeech-plus') {
      newVal = Math.min(2000, s.minSpeechDurationMs + 100);
    } else {
      newVal = parseInt(interaction.customId.slice('minspeech-'.length), 10);
    }

    setMinSpeechDuration(newVal);
    await interaction.update(buildSettingsPanel());
    return;
  }

  // --- Slash commands ---
  if (!interaction.isChatInputCommand()) return;

  if (SETTINGS_COMMAND_NAMES.has(interaction.commandName)) {
    await interaction.reply({ ...buildSettingsPanel(), ephemeral: true });
    return;
  }

  if (!SWITCH_COMMAND_NAMES.has(interaction.commandName)) return;

  // Defer upfront — switchTo can trigger Discord message fetches that take time
  await interaction.deferReply();

  // Auto-join voice if not connected
  if (!router || !pipeline) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply('This command must be used in a server.');
      return;
    }
    await handleJoin(guildId);
    if (!router || !pipeline) {
      await interaction.editReply('Failed to join voice channel.');
      return;
    }
  }

  const channelId = interaction.channelId;
  const result = await router.switchTo(channelId);
  if (!result.success) {
    await interaction.editReply(result.error!);
    return;
  }

  await pipeline!.onChannelSwitch();
  const label = result.displayName || `<#${channelId}>`;

  // Try to move user into voice channel if they're not already there
  let voiceNote = '';
  const member = interaction.member as GuildMember | null;
  if (member?.voice) {
    if (member.voice.channelId !== config.discordVoiceChannelId) {
      if (member.voice.channelId) {
        try {
          await member.voice.setChannel(config.discordVoiceChannelId);
        } catch {
          voiceNote = `\nJoin voice: <#${config.discordVoiceChannelId}>`;
        }
      } else {
        voiceNote = `\nJoin voice: <#${config.discordVoiceChannelId}>`;
      }
    }
  }

  await interaction.editReply(`Switched ${VOICE_APP_NAME} to **${label}**. Loaded ${result.historyCount} history messages.${voiceNote}`);
});

// --- Auto-join on startup ---

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  // Register slash commands
  const tangoCommand = new SlashCommandBuilder()
    .setName(PRIMARY_SWITCH_COMMAND)
    .setDescription(`Switch ${VOICE_APP_NAME} to this channel`);

  const tangoSettingsCommand = new SlashCommandBuilder()
    .setName(PRIMARY_SETTINGS_COMMAND)
    .setDescription(`View and adjust ${VOICE_APP_NAME} settings`);

  const legacySwitchCommand = new SlashCommandBuilder()
    .setName(LEGACY_SWITCH_COMMAND)
    .setDescription(`Legacy alias for /${PRIMARY_SWITCH_COMMAND}`);

  const settingsCommand = new SlashCommandBuilder()
    .setName(LEGACY_SETTINGS_COMMAND)
    .setDescription(`Legacy alias for /${PRIMARY_SETTINGS_COMMAND}`);

  const rest = new REST().setToken(config.discordToken);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, config.discordGuildId),
      {
        body: [
          tangoCommand.toJSON(),
          tangoSettingsCommand.toJSON(),
          legacySwitchCommand.toJSON(),
          settingsCommand.toJSON(),
        ],
      },
    );
    console.log(
      `Registered /${PRIMARY_SWITCH_COMMAND}, /${PRIMARY_SETTINGS_COMMAND}, and legacy /${LEGACY_SWITCH_COMMAND} aliases`,
    );
  } catch (err: any) {
    console.error('Failed to register slash commands:', err.message);
  }

  // Auto-join the configured voice channel
  const guild = client.guilds.cache.get(config.discordGuildId);
  if (guild) {
    const channel = guild.channels.cache.get(config.discordVoiceChannelId);
    if (channel && channel.type === ChannelType.GuildVoice) {
      const humans = channel.members.filter((m) => !m.user.bot);
      if (humans.size > 0) {
        console.log('Users detected in voice channel, auto-joining...');
        await handleJoin(config.discordGuildId);
      } else {
        console.log('No users in voice channel, waiting for someone to join...');
      }
    }
  }
});

// --- Graceful shutdown ---

function shutdown(): void {
  console.log('Shutting down gracefully...');
  handleLeave();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Safety net: log uncaught errors instead of crashing.
// This prevents transient issues (e.g. Discord WebSocket errors) from killing the process.
process.on('uncaughtException', (err) => {
  console.error(`Uncaught exception: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// --- Start ---

client.login(config.discordToken).catch((err) => {
  console.error('Failed to login:', err.message);
  process.exit(1);
});
