import * as fs from 'fs';

import { parseEnvironmentVariables } from './env';
import { expandHomePath, findCodexCLIPath } from './path';

export class CodexCliResolver {
  private resolvedPath: string | null = null;
  private lastConfiguredPath = '';
  private lastEnvText = '';

  resolve(configuredPath: string | undefined, envText: string): string | null {
    const normalizedConfigured = (configuredPath ?? '').trim();
    const normalizedEnv = envText ?? '';

    if (
      this.resolvedPath &&
      normalizedConfigured === this.lastConfiguredPath &&
      normalizedEnv === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastConfiguredPath = normalizedConfigured;
    this.lastEnvText = normalizedEnv;
    this.resolvedPath = resolveCodexCliPath(normalizedConfigured, normalizedEnv);
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastConfiguredPath = '';
    this.lastEnvText = '';
  }
}

export function resolveCodexCliPath(configuredPath: string | undefined, envText: string): string | null {
  const trimmedConfigured = (configuredPath ?? '').trim();
  if (trimmedConfigured) {
    try {
      const expandedPath = expandHomePath(trimmedConfigured);
      if (fs.existsSync(expandedPath) && fs.statSync(expandedPath).isFile()) {
        return expandedPath;
      }
    } catch {
      // Fall through to auto-detect
    }
  }

  const customEnv = parseEnvironmentVariables(envText || '');
  return findCodexCLIPath(customEnv.PATH);
}
