import type ClaudianPlugin from '../../main';
import type { McpServerManager } from '../mcp';
import type { AgentService } from './AgentService';
import { ClaudianService } from './ClaudianService';
import { CodexService } from './CodexService';

export function createAgentService(plugin: ClaudianPlugin, mcpManager: McpServerManager): AgentService {
  if (plugin.settings.agentProvider === 'codex') {
    return new CodexService(plugin, mcpManager);
  }
  return new ClaudianService(plugin, mcpManager);
}
