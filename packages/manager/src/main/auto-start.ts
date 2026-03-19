import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { WORKSPACE_ROOT, LAUNCH_AGENTS_DIR, PLIST_LABEL_PREFIX } from '@mlb/shared';

/** Validate bridge name: only alphanumeric, hyphens, underscores allowed. */
function validateBridgeName(name: string): void {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid bridge name: "${name}". Only letters, numbers, hyphens, and underscores are allowed.`);
  }
}

/** XML-escape a string for safe interpolation into plist XML. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class AutoStartManager {
  /**
   * Get the plist file path for a bridge.
   */
  private getPlistPath(name: string): string {
    return join(LAUNCH_AGENTS_DIR, `${PLIST_LABEL_PREFIX}.${name}.plist`);
  }

  /**
   * Find the path to the bridge binary entry point.
   * Uses the same logic as BridgeProcessManager.findBridgeEntry().
   */
  private findBridgeBinary(): string {
    const { app } = require('electron');

    if (app.isPackaged) {
      for (const name of ['index.mjs', 'index.js']) {
        const p = join(process.resourcesPath, 'bridge', 'dist', name);
        if (existsSync(p)) return p;
      }
    }

    // Development: bridge dist
    const devPath = join(__dirname, '../../bridge/dist/index.js');
    if (existsSync(devPath)) return devPath;

    try {
      return require.resolve('@mlb/bridge');
    } catch { /* ignore */ }

    throw new Error('Cannot find bridge entry point for auto-start configuration');
  }

  /**
   * Enable auto-start for a bridge by creating and loading a launchd plist.
   */
  async enable(name: string): Promise<void> {
    validateBridgeName(name);

    const workspace = join(WORKSPACE_ROOT, name);
    const bridgePath = this.findBridgeBinary();
    const nodePath = process.execPath;
    const plistPath = this.getPlistPath(name);
    const label = `${PLIST_LABEL_PREFIX}.${name}`;

    // Ensure LaunchAgents directory exists
    if (!existsSync(LAUNCH_AGENTS_DIR)) {
      mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    }

    // XML-escape all interpolated values as defense in depth
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(bridgePath)}</string>
    <string>--workspace</string>
    <string>${xmlEscape(workspace)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(workspace)}/bridge.log</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(workspace)}/bridge.err.log</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workspace)}</string>
</dict>
</plist>`;

    writeFileSync(plistPath, plist);
    console.log(`[auto-start] wrote plist: ${plistPath}`);

    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
      console.log(`[auto-start] loaded plist for "${name}"`);
    } catch (err) {
      console.warn(`[auto-start] launchctl load failed:`, (err as Error).message);
    }
  }

  /**
   * Disable auto-start by unloading and removing the launchd plist.
   */
  async disable(name: string): Promise<void> {
    const plistPath = this.getPlistPath(name);

    if (!existsSync(plistPath)) {
      console.log(`[auto-start] no plist found for "${name}"`);
      return;
    }

    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
      console.log(`[auto-start] unloaded plist for "${name}"`);
    } catch {
      // May fail if not loaded, that's fine
    }

    try {
      unlinkSync(plistPath);
      console.log(`[auto-start] removed plist for "${name}"`);
    } catch { /* ignore */ }
  }

  /**
   * Check if auto-start is enabled for a bridge.
   */
  isEnabled(name: string): boolean {
    return existsSync(this.getPlistPath(name));
  }
}
