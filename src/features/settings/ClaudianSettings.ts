import * as fs from 'fs';
import type { App , ButtonComponent} from 'obsidian';
import { Notice, PluginSettingTab, Setting } from 'obsidian';

import { getCurrentPlatformKey, getHostnameKey } from '../../core/types';
import {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_CODEX_MODEL,
  filterVisibleModelOptions,
  getCodexModelOptions,
  parseCustomCodexModelIds,
  serializeCustomCodexModelIds,
} from '../../core/types/models';
import { getAvailableLocales, getLocaleDisplayName, setLocale, t } from '../../i18n';
import type { Locale, TranslationKey } from '../../i18n/types';
import type { WeChatQrLoginState } from '../../integrations/wechat/WeChatBridgeService';
import type ClaudianPlugin from '../../main';
import { findNodeExecutable, formatContextLimit, getCustomModelIds, getEnhancedPath, getModelsFromEnvironment, parseContextLimit, parseEnvironmentVariables } from '../../utils/env';
import { expandHomePath } from '../../utils/path';
import { ClaudianView } from '../chat/ClaudianView';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';
import { AgentSettings } from './ui/AgentSettings';
import { EnvSnippetManager } from './ui/EnvSnippetManager';
import { McpSettingsManager } from './ui/McpSettingsManager';
import { PluginSettingsManager } from './ui/PluginSettingsManager';
import { SlashCommandSettings } from './ui/SlashCommandSettings';

function formatHotkey(hotkey: { modifiers: string[]; key: string }): string {
  const isMac = navigator.platform.includes('Mac');
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((m) => modMap[m] || m);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

function openHotkeySettings(app: App): void {
  const setting = (app as any).setting;
  setting.open();
  setting.openTabById('hotkeys');
  setTimeout(() => {
    const tab = setting.activeTab;
    if (tab) {
      // Handle both old and new Obsidian versions
      const searchEl = tab.searchInputEl ?? tab.searchComponent?.inputEl;
      if (searchEl) {
        searchEl.value = 'Agent';
        tab.updateHotkeyVisibility?.();
      }
    }
  }, 100);
}

function getHotkeyForCommand(app: App, commandId: string): string | null {
  const hotkeyManager = (app as any).hotkeyManager;
  if (!hotkeyManager) return null;

  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys?.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

function addHotkeySettingRow(
  containerEl: HTMLElement,
  app: App,
  commandId: string,
  translationPrefix: string
): void {
  const hotkey = getHotkeyForCommand(app, commandId);
  const item = containerEl.createDiv({ cls: 'claudian-hotkey-item' });
  item.createSpan({ cls: 'claudian-hotkey-name', text: t(`${translationPrefix}.name` as TranslationKey) });
  if (hotkey) {
    item.createSpan({ cls: 'claudian-hotkey-badge', text: hotkey });
  }
  item.addEventListener('click', () => openHotkeySettings(app));
}

export class ClaudianSettingTab extends PluginSettingTab {
  plugin: ClaudianPlugin;
  private contextLimitsContainer: HTMLElement | null = null;
  private wechatQrPollToken = 0;

  constructor(app: App, plugin: ClaudianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private normalizeModelVariantSettings(): void {
    this.plugin.normalizeModelVariantSettings();
  }

  private isClaudeProvider(): boolean {
    return this.plugin.settings.agentProvider === 'claude';
  }

  private getProviderLabel(): string {
    return this.isClaudeProvider() ? 'Claude Code' : 'OpenAI Codex';
  }

  private getCliErrorLabel(): string {
    return this.isClaudeProvider() ? 'Claude CLI' : 'Codex CLI';
  }

  private getUserNameSettingLabel(): string {
    if (this.plugin.settings.locale === 'zh-CN') {
      return this.isClaudeProvider() ? 'Claude 应该如何称呼你？' : 'Codex 应该如何称呼你？';
    }
    if (this.plugin.settings.locale === 'zh-TW') {
      return this.isClaudeProvider() ? 'Claude 應該如何稱呼您？' : 'Codex 應該如何稱呼您？';
    }
    return this.isClaudeProvider() ? 'What should Claude call you?' : 'What should Codex call you?';
  }

  private getUserNameSettingDescription(): string {
    if (this.plugin.settings.locale === 'zh-CN') {
      return '用于个性化问候的用户名（留空使用通用问候）';
    }
    if (this.plugin.settings.locale === 'zh-TW') {
      return '用於個性化問候的用戶名（留空使用通用問候）';
    }
    return 'Your name for personalized greetings (leave empty for generic greetings)';
  }

  hide(): void {
    this.stopWeChatQrLoginPolling();
    super.hide();
  }

  display(): void {
    this.stopWeChatQrLoginPolling();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('claudian-settings');

    setLocale(this.plugin.settings.locale);

    new Setting(containerEl)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dropdown) => {
        const locales = getAvailableLocales();
        for (const locale of locales) {
          dropdown.addOption(locale, getLocaleDisplayName(locale));
        }
        dropdown
          .setValue(this.plugin.settings.locale)
          .onChange(async (value: Locale) => {
            if (!setLocale(value)) {
              // Invalid locale - reset dropdown to current value
              dropdown.setValue(this.plugin.settings.locale);
              return;
            }
            this.plugin.settings.locale = value;
            await this.plugin.saveSettings();
            // Re-render the entire settings page with new language
            this.display();
          });
      });

    new Setting(containerEl).setName(t('settings.customization')).setHeading();

    new Setting(containerEl)
      .setName('Agent provider')
      .setDesc('Choose which terminal AI backend powers the chat experience.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('claude', 'Claude Code')
          .addOption('codex', 'OpenAI Codex')
          .setValue(this.plugin.settings.agentProvider)
          .onChange(async (value: 'claude' | 'codex') => {
            if (this.plugin.settings.agentProvider === value) return;

            this.plugin.settings.agentProvider = value;
            if (value === 'codex') {
              this.plugin.settings.lastClaudeModel = this.plugin.settings.model;
              this.plugin.settings.model = this.plugin.settings.lastCodexModel || DEFAULT_CODEX_MODEL;
              this.plugin.settings.titleGenerationModel = this.plugin.settings.titleGenerationModel || this.plugin.settings.model;
            } else {
              this.plugin.settings.lastCodexModel = this.plugin.settings.model;
              this.plugin.settings.model = this.plugin.settings.lastClaudeModel || DEFAULT_CLAUDE_MODELS[0].value;
              this.normalizeModelVariantSettings();
            }

            await this.plugin.saveSettings();
            for (const view of this.plugin.getAllViews()) {
              const tabManager = view.getTabManager();
              if (!tabManager) continue;

              for (const tab of tabManager.getAllTabs()) {
                tab.service?.cleanup();
                tab.service = null;
                tab.serviceInitialized = false;
                await tab.controllers.conversationController?.createNew({ force: true });
                tab.conversationId = tab.state.currentConversationId;
              }
              view.refreshModelSelector();
              view.refreshBranding();
            }
            this.display();
          });
      });

    new Setting(containerEl)
      .setName(this.getUserNameSettingLabel())
      .setDesc(this.getUserNameSettingDescription())
      .addText((text) => {
        text
          .setPlaceholder(this.getUserNameSettingLabel())
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('system\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^#/, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl)
      .setName(t('settings.mediaFolder.name'))
      .setDesc(this.isClaudeProvider()
        ? t('settings.mediaFolder.desc')
        : 'Folder containing attachments/images. When notes use ![[image.jpg]], the selected agent will look here. Leave empty for vault root.')
      .addText((text) => {
        text
          .setPlaceholder('attachments')
          .setValue(this.plugin.settings.mediaFolder)
          .onChange(async (value) => {
            this.plugin.settings.mediaFolder = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass('claudian-settings-media-input');
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.systemPrompt.name'))
      .setDesc(t('settings.systemPrompt.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.systemPrompt.name'))
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.enableAutoScroll.name'))
      .setDesc(t('settings.enableAutoScroll.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoScroll ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoScroll = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.autoTitle.name'))
      .setDesc(t('settings.autoTitle.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoTitleGeneration)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoTitleGeneration = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.enableAutoTitleGeneration) {
      new Setting(containerEl)
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          // Add "Auto" option (empty string = use default logic)
          dropdown.addOption('', t('settings.titleModel.auto'));

          // Get available models from environment or defaults
          const models = this.plugin.settings.agentProvider === 'codex'
            ? getCodexModelOptions(this.plugin.settings.customCodexModels, this.plugin.settings.model)
            : (() => {
              const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
              const customModels = getModelsFromEnvironment(envVars);
              return filterVisibleModelOptions(
                customModels.length > 0 ? customModels : [...DEFAULT_CLAUDE_MODELS],
                this.plugin.settings.enableOpus1M,
                this.plugin.settings.enableSonnet1M
              );
            })();

          for (const model of models) {
            dropdown.addOption(model.value, model.label);
          }

          dropdown
            .setValue(this.plugin.settings.titleGenerationModel || '')
            .onChange(async (value) => {
              this.plugin.settings.titleGenerationModel = value;
              await this.plugin.saveSettings();
            });
        });
    }

    if (!this.isClaudeProvider()) {
      new Setting(containerEl)
        .setName('Custom Codex models')
        .setDesc('Add one model ID per line. These models will appear in the Codex model dropdown so Obsidian can match what your terminal supports.')
        .addTextArea((text) => {
          text
            .setPlaceholder('gpt-5.4\ngpt-5.4-mini\ngpt-5.3-codex')
            .setValue(serializeCustomCodexModelIds(this.plugin.settings.customCodexModels))
            .onChange(async (value) => {
              const customModels = parseCustomCodexModelIds(value);
              this.plugin.settings.customCodexModels = customModels;

              const availableModelIds = new Set(
                getCodexModelOptions(customModels, this.plugin.settings.model).map((model) => model.value)
              );

              if (!availableModelIds.has(this.plugin.settings.model)) {
                this.plugin.settings.model = DEFAULT_CODEX_MODEL;
              }

              if (this.plugin.settings.titleGenerationModel && !availableModelIds.has(this.plugin.settings.titleGenerationModel)) {
                this.plugin.settings.titleGenerationModel = '';
              }

              await this.plugin.saveSettings();
              for (const view of this.plugin.getAllViews()) {
                view.refreshModelSelector();
              }
            });

          text.inputEl.rows = 4;
          text.inputEl.cols = 30;
        });
    }

    new Setting(containerEl)
      .setName(t('settings.navMappings.name'))
      .setDesc(t('settings.navMappings.desc'))
      .addTextArea((text) => {
        let pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
        let saveTimeout: number | null = null;

        const commitValue = async (showError: boolean): Promise<void> => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
            saveTimeout = null;
          }

          const result = parseNavMappings(pendingValue);
          if (!result.settings) {
            if (showError) {
              new Notice(`${t('common.error')}: ${result.error}`);
              pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
              text.setValue(pendingValue);
            }
            return;
          }

          this.plugin.settings.keyboardNavigation.scrollUpKey = result.settings.scrollUp;
          this.plugin.settings.keyboardNavigation.scrollDownKey = result.settings.scrollDown;
          this.plugin.settings.keyboardNavigation.focusInputKey = result.settings.focusInput;
          await this.plugin.saveSettings();
          pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
          text.setValue(pendingValue);
        };

        const scheduleSave = (): void => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
          }
          saveTimeout = window.setTimeout(() => {
            void commitValue(false);
          }, 500);
        };

        text
          .setPlaceholder('map w scrollUp\nmap s scrollDown\nmap i focusInput')
          .setValue(pendingValue)
          .onChange((value) => {
            pendingValue = value;
            scheduleSave();
          });

        text.inputEl.rows = 3;
        text.inputEl.addEventListener('blur', async () => {
          await commitValue(true);
        });
      });

    // Tab bar position setting
    new Setting(containerEl)
      .setName(t('settings.tabBarPosition.name'))
      .setDesc(t('settings.tabBarPosition.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('input', t('settings.tabBarPosition.input'))
          .addOption('header', t('settings.tabBarPosition.header'))
          .setValue(this.plugin.settings.tabBarPosition ?? 'input')
          .onChange(async (value: 'input' | 'header') => {
            this.plugin.settings.tabBarPosition = value;
            await this.plugin.saveSettings();

            // Update all views' layouts immediately
            for (const leaf of this.plugin.app.workspace.getLeavesOfType('claudian-view')) {
              if (leaf.view instanceof ClaudianView) {
                leaf.view.updateLayoutForPosition();
              }
            }
          });
      });

    // Open in main tab setting
    new Setting(containerEl)
      .setName(t('settings.openInMainTab.name'))
      .setDesc(t('settings.openInMainTab.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openInMainTab)
          .onChange(async (value) => {
            this.plugin.settings.openInMainTab = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName(t('settings.hotkeys')).setHeading();

    const hotkeyGrid = containerEl.createDiv({ cls: 'claudian-hotkey-grid' });
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:inline-edit', 'settings.inlineEditHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:open-view', 'settings.openChatHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-session', 'settings.newSessionHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-tab', 'settings.newTabHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:close-current-tab', 'settings.closeTabHotkey');

    new Setting(containerEl).setName(t('settings.slashCommands.name')).setHeading();

    const slashCommandsDesc = containerEl.createDiv({ cls: 'claudian-sp-settings-desc' });
    const descP = slashCommandsDesc.createEl('p', { cls: 'setting-item-description' });
    descP.appendText(t('settings.slashCommands.desc') + ' ');
    descP.createEl('a', {
      text: 'Learn more',
      href: this.isClaudeProvider()
        ? 'https://code.claude.com/docs/en/skills'
        : 'https://platform.openai.com/docs/codex',
    });

    const slashCommandsContainer = containerEl.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(slashCommandsContainer, this.plugin);

    new Setting(containerEl)
      .setName(t('settings.hiddenSlashCommands.name'))
      .setDesc(this.isClaudeProvider()
        ? t('settings.hiddenSlashCommands.desc')
        : 'Hide specific slash commands from the dropdown. Useful for hiding commands that are not relevant to the active provider. Enter command names without the leading slash, one per line.')
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.hiddenSlashCommands.placeholder'))
          .setValue((this.plugin.settings.hiddenSlashCommands || []).join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.hiddenSlashCommands = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^\//, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateHiddenSlashCommands();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl).setName(t('settings.subagents.name')).setHeading();

    const agentsDesc = containerEl.createDiv({ cls: 'claudian-sp-settings-desc' });
    agentsDesc.createEl('p', {
      text: this.isClaudeProvider()
        ? t('settings.subagents.desc')
        : 'Configure custom subagents that the selected agent can delegate to.',
      cls: 'setting-item-description',
    });

    const agentsContainer = containerEl.createDiv({ cls: 'claudian-agents-container' });
    new AgentSettings(agentsContainer, this.plugin);

    new Setting(containerEl).setName(t('settings.mcpServers.name')).setHeading();

    const mcpDesc = containerEl.createDiv({ cls: 'claudian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: this.isClaudeProvider()
        ? t('settings.mcpServers.desc')
        : 'Configure Model Context Protocol servers to extend the selected agent with external tools and data sources.',
      cls: 'setting-item-description',
    });

    const mcpContainer = containerEl.createDiv({ cls: 'claudian-mcp-container' });
    new McpSettingsManager(mcpContainer, this.plugin);

    if (this.isClaudeProvider()) {
      new Setting(containerEl).setName(t('settings.plugins.name')).setHeading();

      const pluginsDesc = containerEl.createDiv({ cls: 'claudian-plugin-settings-desc' });
      pluginsDesc.createEl('p', {
        text: t('settings.plugins.desc'),
        cls: 'setting-item-description',
      });

      const pluginsContainer = containerEl.createDiv({ cls: 'claudian-plugins-container' });
      new PluginSettingsManager(pluginsContainer, this.plugin);
    }

    new Setting(containerEl).setName(t('settings.safety')).setHeading();

    if (this.isClaudeProvider()) {
      new Setting(containerEl)
        .setName(t('settings.loadUserSettings.name'))
        .setDesc(t('settings.loadUserSettings.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.loadUserClaudeSettings)
            .onChange(async (value) => {
              this.plugin.settings.loadUserClaudeSettings = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName(t('settings.enableBlocklist.name'))
      .setDesc(t('settings.enableBlocklist.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBlocklist)
          .onChange(async (value) => {
            this.plugin.settings.enableBlocklist = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.allowExternalAccess.name'))
      .setDesc(t('settings.allowExternalAccess.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowExternalAccess)
          .onChange(async (value) => {
            this.plugin.settings.allowExternalAccess = value;
            await this.plugin.saveSettings();
            this.display();
            await this.restartServiceForPromptChange();
          })
      );

    const platformKey = getCurrentPlatformKey();
    const isWindows = platformKey === 'windows';
    const platformLabel = isWindows ? 'Windows' : 'Unix';

    new Setting(containerEl)
      .setName(t('settings.blockedCommands.name', { platform: platformLabel }))
      .setDesc(t('settings.blockedCommands.desc', { platform: platformLabel }))
      .addTextArea((text) => {
        const placeholder = isWindows
          ? 'del /s /q\nrd /s /q\nRemove-Item -Recurse -Force'
          : 'rm -rf\nchmod 777\nmkfs';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.blockedCommands[platformKey].join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.blockedCommands[platformKey] = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
      });

    // On Windows, show Unix blocklist too since Git Bash can run Unix commands
    if (isWindows) {
      new Setting(containerEl)
        .setName(t('settings.blockedCommands.unixName'))
        .setDesc(t('settings.blockedCommands.unixDesc'))
        .addTextArea((text) => {
          text
            .setPlaceholder('rm -rf\nchmod 777\nmkfs')
            .setValue(this.plugin.settings.blockedCommands.unix.join('\n'))
            .onChange(async (value) => {
              this.plugin.settings.blockedCommands.unix = value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 4;
          text.inputEl.cols = 40;
        });
    }

    new Setting(containerEl)
      .setName(t('settings.exportPaths.name'))
      .setDesc(
        this.plugin.settings.allowExternalAccess
          ? t('settings.exportPaths.disabledDesc')
          : t('settings.exportPaths.desc')
      )
      .addTextArea((text) => {
        const placeholder = process.platform === 'win32'
          ? '~/Desktop\n~/Downloads\n%TEMP%'
          : '~/Desktop\n~/Downloads\n/tmp';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.allowedExportPaths.join('\n'))
          .setDisabled(this.plugin.settings.allowExternalAccess)
          .onChange(async (value) => {
            this.plugin.settings.allowedExportPaths = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl).setName(t('settings.environment')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.customVariables.name'))
      .setDesc(this.isClaudeProvider()
        ? t('settings.customVariables.desc')
        : 'Environment variables for the selected provider SDK/CLI (KEY=VALUE format, one per line). Shell export prefix supported.')
      .addTextArea((text) => {
        text
          .setPlaceholder('ANTHROPIC_API_KEY=your-key\nANTHROPIC_BASE_URL=https://api.example.com\nANTHROPIC_MODEL=custom-model')
          .setPlaceholder('ANTHROPIC_API_KEY=...\nOPENAI_API_KEY=...\nANTHROPIC_MODEL=custom-model\nOPENAI_BASE_URL=https://api.example.com')
          .setValue(this.plugin.settings.environmentVariables);
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addClass('claudian-settings-env-textarea');
        text.inputEl.addEventListener('blur', async () => {
          await this.plugin.applyEnvironmentVariables(text.inputEl.value);
          this.renderContextLimitsSection();
        });
      });

    this.contextLimitsContainer = containerEl.createDiv({ cls: 'claudian-context-limits-container' });
    this.renderContextLimitsSection();

    const envSnippetsContainer = containerEl.createDiv({ cls: 'claudian-env-snippets-container' });
    new EnvSnippetManager(envSnippetsContainer, this.plugin, () => {
      this.renderContextLimitsSection();
    });

    new Setting(containerEl).setName(t('settings.advanced')).setHeading();

    if (this.plugin.settings.agentProvider === 'claude') {
      new Setting(containerEl)
        .setName(t('settings.enableOpus1M.name'))
        .setDesc(t('settings.enableOpus1M.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.enableOpus1M ?? false)
            .onChange(async (value) => {
              this.plugin.settings.enableOpus1M = value;
              this.normalizeModelVariantSettings();
              await this.plugin.saveSettings();
              for (const view of this.plugin.getAllViews()) {
                view.refreshModelSelector();
              }
              this.display();
            })
        );

      new Setting(containerEl)
        .setName(t('settings.enableSonnet1M.name'))
        .setDesc(t('settings.enableSonnet1M.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.enableSonnet1M ?? false)
            .onChange(async (value) => {
              this.plugin.settings.enableSonnet1M = value;
              this.normalizeModelVariantSettings();
              await this.plugin.saveSettings();
              for (const view of this.plugin.getAllViews()) {
                view.refreshModelSelector();
              }
              this.display();
            })
        );
    }

    if (this.isClaudeProvider()) {
      new Setting(containerEl)
        .setName(t('settings.enableChrome.name'))
        .setDesc(t('settings.enableChrome.desc'))
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.enableChrome ?? false)
            .onChange(async (value) => {
              this.plugin.settings.enableChrome = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName(t('settings.enableBangBash.name'))
      .setDesc(t('settings.enableBangBash.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBangBash ?? false)
          .onChange(async (value) => {
            bangBashValidationEl.style.display = 'none';
            if (value) {
              const enhancedPath = getEnhancedPath();
              const nodePath = findNodeExecutable(enhancedPath);
              if (!nodePath) {
                bangBashValidationEl.setText(t('settings.enableBangBash.validation.noNode'));
                bangBashValidationEl.style.display = 'block';
                toggle.setValue(false);
                return;
              }
            }
            this.plugin.settings.enableBangBash = value;
            await this.plugin.saveSettings();
          })
      );

    const bangBashValidationEl = containerEl.createDiv({ cls: 'claudian-bang-bash-validation' });
    bangBashValidationEl.style.color = 'var(--text-error)';
    bangBashValidationEl.style.fontSize = '0.85em';
    bangBashValidationEl.style.marginTop = '-0.5em';
    bangBashValidationEl.style.marginBottom = '0.5em';
    bangBashValidationEl.style.display = 'none';

    new Setting(containerEl).setName('Telegram Bridge').setHeading();

    new Setting(containerEl)
      .setName('Enable Telegram bridge')
      .setDesc('Long-poll Telegram for remote prompts and reply with Codian execution results.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.telegram.enabled)
          .onChange(async (value) => {
            this.plugin.settings.telegram.enabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Telegram bot token')
      .setDesc('Bot token from BotFather. The bridge only starts when this field is set and enabled.')
      .addText((text) => {
        text
          .setPlaceholder('123456789:AA...')
          .setValue(this.plugin.settings.telegram.botToken)
          .onChange(async (value) => {
            this.plugin.settings.telegram.botToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('Allowed Telegram user IDs')
      .setDesc('One numeric user ID per line. Leave empty to allow any user in allowed chats.')
      .addTextArea((text) => {
        text
          .setPlaceholder('123456789')
          .setValue(this.plugin.settings.telegram.allowedUserIds.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.telegram.allowedUserIds = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName('Allowed Telegram chat IDs')
      .setDesc('One chat ID per line. Leave empty to allow any chat that passes the user filter.')
      .addTextArea((text) => {
        text
          .setPlaceholder('123456789\n-1001234567890')
          .setValue(this.plugin.settings.telegram.allowedChatIds.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.telegram.allowedChatIds = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName('Allow group chats')
      .setDesc('Off by default. Keep this disabled unless you explicitly trust the group chat.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.telegram.allowGroupChats)
          .onChange(async (value) => {
            this.plugin.settings.telegram.allowGroupChats = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Telegram poll timeout')
      .setDesc('Long-poll timeout in seconds. Higher values reduce request churn.')
      .addSlider((slider) => {
        slider
          .setLimits(10, 60, 5)
          .setValue(this.plugin.settings.telegram.pollTimeoutSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.telegram.pollTimeoutSeconds = value;
            await this.plugin.saveSettings();
          });
      });

    const telegramStatusDesc = containerEl.createDiv({ cls: 'claudian-telegram-status' });
    telegramStatusDesc.style.fontSize = '0.9em';
    telegramStatusDesc.style.marginTop = '-0.25em';
    telegramStatusDesc.style.marginBottom = '0.75em';
    telegramStatusDesc.style.color = 'var(--text-muted)';
    telegramStatusDesc.setText(`Status: ${this.plugin.telegramBridge?.getStatusSummary() ?? 'Unavailable'}`);

    new Setting(containerEl)
      .setName('Test Telegram connection')
      .setDesc('Check whether the configured bot token can reach the Telegram Bot API.')
      .addButton((button) => {
        button
          .setButtonText('Test')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Testing...');
            const message = await this.plugin.telegramBridge?.testConnection() ?? 'Telegram bridge is unavailable.';
            telegramStatusDesc.setText(`Status: ${this.plugin.telegramBridge?.getStatusSummary() ?? message}`);
            new Notice(message);
            button.setDisabled(false);
            button.setButtonText('Test');
          });
      });

    new Setting(containerEl)
      .setName('Reset Telegram bridge')
      .setDesc('Force-stop the current polling loop and start a fresh one. Use this if Telegram messages stop being processed.')
      .addButton((button) => {
        button
          .setButtonText('Reset')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Resetting...');
            await this.plugin.telegramBridge?.reset();
            telegramStatusDesc.setText(`Status: ${this.plugin.telegramBridge?.getStatusSummary() ?? 'Unavailable'}`);
            new Notice('Telegram bridge reset.');
            button.setDisabled(false);
            button.setButtonText('Reset');
          });
      });

    new Setting(containerEl).setName('WeChat ClawBot Bridge').setHeading();

    new Setting(containerEl)
      .setName('Enable WeChat bridge')
      .setDesc('Long-poll the official WeChat ClawBot gateway for remote prompts and reply with Codian execution results. Current MVP supports text messages only.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.wechat.enabled)
          .onChange(async (value) => {
            this.plugin.settings.wechat.enabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('WeChat gateway base URL')
      .setDesc('Official gateway default is https://ilinkai.weixin.qq.com. Change this only if your WeChat bridge runs against a different upstream.')
      .addText((text) => {
        text
          .setPlaceholder('https://ilinkai.weixin.qq.com')
          .setValue(this.plugin.settings.wechat.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.wechat.baseUrl = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('WeChat CDN base URL')
      .setDesc('Official CDN default is https://novac2c.cdn.weixin.qq.com/c2c. This is used to download inbound WeChat images.')
      .addText((text) => {
        text
          .setPlaceholder('https://novac2c.cdn.weixin.qq.com/c2c')
          .setValue(this.plugin.settings.wechat.cdnBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.wechat.cdnBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('WeChat bot token')
      .setDesc('Bot token issued by the official WeChat ClawBot / OpenClaw login flow.')
      .addText((text) => {
        text
          .setPlaceholder('Paste imported WeChat bot token')
          .setValue(this.plugin.settings.wechat.botToken)
          .onChange(async (value) => {
            this.plugin.settings.wechat.botToken = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('WeChat account ID')
      .setDesc('Optional. Used when importing one specific account from the local OpenClaw state directory.')
      .addText((text) => {
        text
          .setPlaceholder('b0f5860fdecb-im-bot')
          .setValue(this.plugin.settings.wechat.accountId)
          .onChange(async (value) => {
            this.plugin.settings.wechat.accountId = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('WeChat route tag')
      .setDesc('Optional advanced header. Imported automatically from OpenClaw when present.')
      .addText((text) => {
        text
          .setPlaceholder('SKRouteTag')
          .setValue(this.plugin.settings.wechat.routeTag)
          .onChange(async (value) => {
            this.plugin.settings.wechat.routeTag = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    new Setting(containerEl)
      .setName('Allowed WeChat user IDs')
      .setDesc('One user ID per line. Leave empty to allow any direct message that reaches the configured WeChat account.')
      .addTextArea((text) => {
        text
          .setPlaceholder('wxid_xxx@im.wechat')
          .setValue(this.plugin.settings.wechat.allowedUserIds.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.wechat.allowedUserIds = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName('WeChat poll timeout')
      .setDesc('Long-poll timeout in seconds. The upstream may override this per response.')
      .addSlider((slider) => {
        slider
          .setLimits(5, 60, 5)
          .setValue(this.plugin.settings.wechat.pollTimeoutSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.wechat.pollTimeoutSeconds = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('OpenClaw state directory')
      .setDesc('Leave empty to use the default local OpenClaw state directory. This is used only by the import button below.')
      .addText((text) => {
        const placeholder = this.plugin.wechatBridge?.getDefaultOpenClawStateDir() ?? '';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.wechat.openClawStateDir)
          .onChange(async (value) => {
            this.plugin.settings.wechat.openClawStateDir = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      });

    const wechatStatusDesc = containerEl.createDiv({ cls: 'claudian-wechat-status' });
    wechatStatusDesc.style.fontSize = '0.9em';
    wechatStatusDesc.style.marginTop = '-0.25em';
    wechatStatusDesc.style.marginBottom = '0.75em';
    wechatStatusDesc.style.color = 'var(--text-muted)';
    wechatStatusDesc.setText(`Status: ${this.plugin.wechatBridge?.getStatusSummary() ?? 'Unavailable'}`);

    this.renderWeChatQrLoginSection(containerEl, wechatStatusDesc);

    new Setting(containerEl)
      .setName('Import WeChat account from OpenClaw')
      .setDesc('Read the bot token and base URL from a local OpenClaw WeChat login. If multiple accounts exist, fill in the account ID first.')
      .addButton((button) => {
        button
          .setButtonText('Import')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Importing...');
            try {
              const message = await this.plugin.wechatBridge?.importAccountFromOpenClaw(
                this.plugin.settings.wechat.accountId,
                this.plugin.settings.wechat.openClawStateDir,
              ) ?? 'WeChat bridge is unavailable.';
              wechatStatusDesc.setText(`Status: ${this.plugin.wechatBridge?.getStatusSummary() ?? message}`);
              new Notice(message);
              this.display();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(message);
            } finally {
              button.setDisabled(false);
              button.setButtonText('Import');
            }
          });
      });

    new Setting(containerEl)
      .setName('Test WeChat connection')
      .setDesc('Check whether the configured WeChat gateway and bot token can be reached.')
      .addButton((button) => {
        button
          .setButtonText('Test')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Testing...');
            const message = await this.plugin.wechatBridge?.testConnection() ?? 'WeChat bridge is unavailable.';
            wechatStatusDesc.setText(`Status: ${this.plugin.wechatBridge?.getStatusSummary() ?? message}`);
            new Notice(message);
            button.setDisabled(false);
            button.setButtonText('Test');
          });
      });

    new Setting(containerEl)
      .setName('Reset WeChat bridge')
      .setDesc('Force-stop the current polling loop and clear the sync cursor. Use this if WeChat messages stop being processed.')
      .addButton((button) => {
        button
          .setButtonText('Reset')
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText('Resetting...');
            await this.plugin.wechatBridge?.reset();
            wechatStatusDesc.setText(`Status: ${this.plugin.wechatBridge?.getStatusSummary() ?? 'Unavailable'}`);
            new Notice('WeChat bridge reset.');
            button.setDisabled(false);
            button.setButtonText('Reset');
          });
      });

    const maxTabsSetting = new Setting(containerEl)
      .setName(t('settings.maxTabs.name'))
      .setDesc(t('settings.maxTabs.desc'));

    const maxTabsWarningEl = containerEl.createDiv({ cls: 'claudian-max-tabs-warning' });
    maxTabsWarningEl.style.color = 'var(--text-warning)';
    maxTabsWarningEl.style.fontSize = '0.85em';
    maxTabsWarningEl.style.marginTop = '-0.5em';
    maxTabsWarningEl.style.marginBottom = '0.5em';
    maxTabsWarningEl.style.display = 'none';
    maxTabsWarningEl.setText(t('settings.maxTabs.warning'));

    const updateMaxTabsWarning = (value: number): void => {
      maxTabsWarningEl.style.display = value > 5 ? 'block' : 'none';
    };

    maxTabsSetting.addSlider((slider) => {
      slider
        .setLimits(3, 10, 1)
        .setValue(this.plugin.settings.maxTabs ?? 3)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxTabs = value;
          await this.plugin.saveSettings();
          updateMaxTabsWarning(value);
        });
      updateMaxTabsWarning(this.plugin.settings.maxTabs ?? 3);
    });

    const hostnameKey = getHostnameKey();

    const cliPathDescription = this.isClaudeProvider()
      ? (process.platform === 'win32'
        ? 'Custom path to Claude Code CLI. For native installs, use claude.exe. For package manager installs, use the cli.js path instead of claude.cmd.'
        : 'Custom path to Claude Code CLI. Paste the output of "which claude" or the resolved Claude binary path.')
      : 'Custom path to the Codex CLI. Leave empty to use the packaged default.';

    const cliPathSetting = new Setting(containerEl)
      .setName(`${this.isClaudeProvider() ? t('settings.cliPath.name') : 'Codex CLI path'} (${hostnameKey})`)
      .setDesc(cliPathDescription);

    const validationEl = containerEl.createDiv({ cls: 'claudian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null; // Empty is valid (auto-detect)

      const expandedPath = expandHomePath(trimmed);

      if (!fs.existsSync(expandedPath)) {
          return `${this.getCliErrorLabel()} path does not exist.`;
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
          return `${this.getCliErrorLabel()} path must point to a file, not a directory.`;
      }
      return null;
    };

    cliPathSetting.addText((text) => {
      const placeholder = this.isClaudeProvider()
        ? (process.platform === 'win32'
          ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
          : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')
        : (process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Local\\Programs\\OpenAI Codex\\codex.exe'
          : '/usr/local/bin/codex');

      const currentValue = this.isClaudeProvider()
        ? (this.plugin.settings.claudeCliPathsByHost?.[hostnameKey] || '')
        : (this.plugin.settings.codexCliPath || '');

      text
        .setPlaceholder(placeholder)
        .setValue(currentValue)
        .onChange(async (value) => {
          const error = validatePath(value);
          if (error) {
            validationEl.setText(error);
            validationEl.style.display = 'block';
            text.inputEl.style.borderColor = 'var(--text-error)';
          } else {
            validationEl.style.display = 'none';
            text.inputEl.style.borderColor = '';
          }

          const trimmed = value.trim();
          if (this.isClaudeProvider()) {
            if (!this.plugin.settings.claudeCliPathsByHost) {
              this.plugin.settings.claudeCliPathsByHost = {};
            }
            this.plugin.settings.claudeCliPathsByHost[hostnameKey] = trimmed;
          } else {
            this.plugin.settings.codexCliPath = trimmed;
          }
          await this.plugin.saveSettings();
          if (this.isClaudeProvider()) {
            this.plugin.cliResolver?.reset();
          } else {
            this.plugin.codexCliResolver?.reset();
          }
          const view = this.plugin.getView();
          await view?.getTabManager()?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup())
          );
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      const initialError = validatePath(currentValue);
      if (initialError) {
        validationEl.setText(initialError);
        validationEl.style.display = 'block';
        text.inputEl.style.borderColor = 'var(--text-error)';
      }
    });

  }

  private renderContextLimitsSection(): void {
    const container = this.contextLimitsContainer;
    if (!container) return;

    container.empty();

    const envVars = parseEnvironmentVariables(this.plugin.settings.environmentVariables);
    const uniqueModelIds = getCustomModelIds(envVars);

    if (uniqueModelIds.size === 0) {
      return;
    }

    const headerEl = container.createDiv({ cls: 'claudian-context-limits-header' });
    headerEl.createSpan({ text: t('settings.customContextLimits.name'), cls: 'claudian-context-limits-label' });

    const descEl = container.createDiv({ cls: 'claudian-context-limits-desc' });
    descEl.setText(t('settings.customContextLimits.desc'));

    const listEl = container.createDiv({ cls: 'claudian-context-limits-list' });

    for (const modelId of uniqueModelIds) {
      const currentValue = this.plugin.settings.customContextLimits?.[modelId];

      const itemEl = listEl.createDiv({ cls: 'claudian-context-limits-item' });

      const nameEl = itemEl.createDiv({ cls: 'claudian-context-limits-model' });
      nameEl.setText(modelId);

      const inputWrapper = itemEl.createDiv({ cls: 'claudian-context-limits-input-wrapper' });

      const inputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: '200k',
        cls: 'claudian-context-limits-input',
        value: currentValue ? formatContextLimit(currentValue) : '',
      });

      // Validation element
      const validationEl = inputWrapper.createDiv({ cls: 'claudian-context-limit-validation' });

      inputEl.addEventListener('input', async () => {
        const trimmed = inputEl.value.trim();

        if (!this.plugin.settings.customContextLimits) {
          this.plugin.settings.customContextLimits = {};
        }

        if (!trimmed) {
          // Empty = use default (remove from custom limits)
          delete this.plugin.settings.customContextLimits[modelId];
          validationEl.style.display = 'none';
          inputEl.classList.remove('claudian-input-error');
        } else {
          const parsed = parseContextLimit(trimmed);
          if (parsed === null) {
            validationEl.setText(t('settings.customContextLimits.invalid'));
            validationEl.style.display = 'block';
            inputEl.classList.add('claudian-input-error');
            return; // Don't save invalid value
          }

          this.plugin.settings.customContextLimits[modelId] = parsed;
          validationEl.style.display = 'none';
          inputEl.classList.remove('claudian-input-error');
        }

        await this.plugin.saveSettings();
      });
    }
  }

  private async restartServiceForPromptChange(): Promise<void> {
    const view = this.plugin.getView();
    const tabManager = view?.getTabManager();
    if (!tabManager) return;

    try {
      await tabManager.broadcastToAllTabs(
        async (service) => { await service.ensureReady({ force: true }); }
      );
    } catch {
      // Silently ignore restart failures - changes will apply on next conversation
    }
  }

  private renderWeChatQrLoginSection(containerEl: HTMLElement, wechatStatusDesc: HTMLElement): void {
    const buttonState = {
      busy: false,
    };

    let qrActionButton: ButtonComponent | null = null;

    const defaultState = this.plugin.wechatBridge?.getQrLoginState() ?? {
      active: false,
      status: 'idle',
      message: 'WeChat bridge is unavailable.',
    };

    const updateWeChatStatus = (): void => {
      wechatStatusDesc.setText(`Status: ${this.plugin.wechatBridge?.getStatusSummary() ?? 'Unavailable'}`);
    };

    const updateQrButton = (state: WeChatQrLoginState): void => {
      if (!qrActionButton) {
        return;
      }
      qrActionButton.setDisabled(buttonState.busy);
      if (buttonState.busy) {
        qrActionButton.setButtonText(state.active ? 'Refreshing QR...' : 'Generating QR...');
        return;
      }
      qrActionButton.setButtonText(state.active ? 'Regenerate QR' : 'Generate QR');
    };

    const renderQrState = (state: WeChatQrLoginState): void => {
      qrStatusDesc.setText(`QR login: ${state.message}`);
      if (state.qrCodeUrl) {
        qrPanel.style.display = 'block';
        qrImageEl.src = state.qrCodeUrl;
        qrOpenLinkEl.href = state.qrCodeUrl;
        qrHintEl.setText('Scan the QR code with WeChat and confirm the login on your phone. Codian keeps polling until the login is confirmed or the QR code expires.');
      } else {
        qrPanel.style.display = 'none';
        qrImageEl.removeAttribute('src');
        qrOpenLinkEl.href = '#';
        qrHintEl.empty();
      }
      updateQrButton(state);
    };

    const handleQrPollFailure = (message: string): void => {
      const failedState: WeChatQrLoginState = {
        active: false,
        status: 'failed',
        message,
      };
      renderQrState(failedState);
      updateWeChatStatus();
      new Notice(message);
    };

    const beginQrPolling = (sessionKey: string): void => {
      this.stopWeChatQrLoginPolling();
      const pollToken = ++this.wechatQrPollToken;

      const pollLoop = async (): Promise<void> => {
        while (pollToken === this.wechatQrPollToken) {
          const result = await this.plugin.wechatBridge?.pollQrLogin(sessionKey);
          if (pollToken !== this.wechatQrPollToken || !result) {
            return;
          }

          renderQrState(result);
          updateWeChatStatus();

          if (result.connected || !result.active || result.status === 'confirmed' || result.status === 'expired' || result.status === 'failed') {
            if (result.status !== 'waiting' && result.status !== 'scanned') {
              new Notice(result.message);
            }
            if (result.configUpdated) {
              this.display();
            }
            return;
          }

          await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
        }
      };

      void pollLoop().catch((error) => {
        if (pollToken !== this.wechatQrPollToken) {
          return;
        }
        handleQrPollFailure(error instanceof Error ? error.message : String(error));
      });
    };

    new Setting(containerEl)
      .setName('Log in with WeChat QR')
      .setDesc('Generate an official WeChat ClawBot QR code. On success, Codian saves the bot token, account ID, base URL, and enables the WeChat bridge automatically.')
      .addButton((button) => {
        qrActionButton = button;
        updateQrButton(defaultState);
        button.onClick(async () => {
          buttonState.busy = true;
          updateQrButton(this.plugin.wechatBridge?.getQrLoginState() ?? defaultState);
          try {
            const force = (this.plugin.wechatBridge?.getQrLoginState().active ?? false);
            const nextState = await this.plugin.wechatBridge?.startQrLogin(force);
            if (!nextState) {
              handleQrPollFailure('WeChat bridge is unavailable.');
              return;
            }
            renderQrState(nextState);
            updateWeChatStatus();
            if (nextState.active && nextState.sessionKey) {
              beginQrPolling(nextState.sessionKey);
            } else if (nextState.status === 'failed') {
              new Notice(nextState.message);
            }
          } catch (error) {
            handleQrPollFailure(error instanceof Error ? error.message : String(error));
          } finally {
            buttonState.busy = false;
            updateQrButton(this.plugin.wechatBridge?.getQrLoginState() ?? defaultState);
          }
        });
      });

    const qrStatusDesc = containerEl.createDiv({ cls: 'claudian-wechat-qr-status' });
    qrStatusDesc.style.fontSize = '0.9em';
    qrStatusDesc.style.marginTop = '-0.25em';
    qrStatusDesc.style.marginBottom = '0.5em';
    qrStatusDesc.style.color = 'var(--text-muted)';

    const qrPanel = containerEl.createDiv({ cls: 'claudian-wechat-qr-panel' });
    qrPanel.style.display = 'none';
    qrPanel.style.padding = '12px';
    qrPanel.style.marginBottom = '0.75em';
    qrPanel.style.border = '1px solid var(--background-modifier-border)';
    qrPanel.style.borderRadius = '8px';
    qrPanel.style.background = 'var(--background-secondary)';

    const qrImageEl = qrPanel.createEl('img');
    qrImageEl.style.display = 'block';
    qrImageEl.style.width = '220px';
    qrImageEl.style.maxWidth = '100%';
    qrImageEl.style.height = '220px';
    qrImageEl.style.objectFit = 'contain';
    qrImageEl.style.marginBottom = '0.75em';
    qrImageEl.alt = 'WeChat login QR code';

    const qrOpenLinkEl = qrPanel.createEl('a', {
      text: 'Open QR image in browser',
      href: '#',
    });
    qrOpenLinkEl.target = '_blank';
    qrOpenLinkEl.rel = 'noreferrer';
    qrOpenLinkEl.style.display = 'inline-block';
    qrOpenLinkEl.style.marginBottom = '0.5em';

    const qrHintEl = qrPanel.createDiv({ cls: 'claudian-wechat-qr-hint' });
    qrHintEl.style.fontSize = '0.9em';
    qrHintEl.style.color = 'var(--text-muted)';

    renderQrState(defaultState);
    if (defaultState.active && defaultState.sessionKey) {
      beginQrPolling(defaultState.sessionKey);
    }
  }

  private stopWeChatQrLoginPolling(): void {
    this.wechatQrPollToken += 1;
  }

}
