/**
 * Forge Manager — Manages multiple ForgeEngine instances.
 * Provides start/stop/status/list API for gateway integration.
 * v0.8.3: Added disk recovery and enhanced listing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ForgeEngine } from './forge-engine.js';
import type { ForgeProject, ForgeState } from './types.js';

/** Unified log helper */
function fmtLog(projectId: string, msg: string): string {
  const t = new Date().toISOString().replace('T', ' ').substring(0, 19);
  return `[${t}] [forge-mgr] [${projectId}] ${msg}`;
}

/** Disk-only project info (not loaded into memory as engine) */
export interface DiskProject {
  id: string;
  state: ForgeState;
  projectPath: string;
  source: 'memory' | 'disk';
}

export class ForgeManager {
  private engines = new Map<string, ForgeEngine>();
  private readonly projectsRoot: string;

  constructor() {
    this.projectsRoot = join(homedir(), '.deepforge', 'projects');
  }

  /** Start a new forge project */
  async start(project: ForgeProject): Promise<string> {
    if (this.engines.has(project.id)) {
      throw new Error(`Project ${project.id} is already running`);
    }

    const engine = new ForgeEngine(project, {
      log: (msg) => console.log(fmtLog(project.id, msg)),
    });

    this.engines.set(project.id, engine);

    // Run in background (non-blocking), clean up on finish
    engine.run().then(() => {
      console.log(fmtLog(project.id, 'Completed'));
      this.engines.delete(project.id);
    }).catch((err) => {
      console.error(fmtLog(project.id, `Fatal: ${(err as Error).message}`));
      this.engines.delete(project.id);
    });

    return project.id;
  }

  /** Stop a running project */
  stop(projectId: string): boolean {
    const engine = this.engines.get(projectId);
    if (!engine) return false;
    engine.stop();
    this.engines.delete(projectId);
    return true;
  }

  /** Get status of a project (in-memory or from disk) */
  status(projectId: string): ForgeState | null {
    // Check in-memory first
    const engine = this.engines.get(projectId);
    if (engine) return engine.currentState;

    // Fall back to disk
    const statePath = join(this.projectsRoot, projectId, 'forge-state.json');
    if (existsSync(statePath)) {
      try {
        return JSON.parse(readFileSync(statePath, 'utf-8'));
      } catch { /* corrupt file */ }
    }
    return null;
  }

  /** List projects. By default only in-memory (running). With includeCompleted, also scans disk. */
  list(opts?: { includeCompleted?: boolean }): DiskProject[] {
    const result: DiskProject[] = [];

    // In-memory engines
    for (const [id, engine] of this.engines) {
      result.push({
        id,
        state: engine.currentState,
        projectPath: join(this.projectsRoot, id),
        source: 'memory',
      });
    }

    if (opts?.includeCompleted) {
      // Scan disk for projects not in memory
      const diskProjects = this.scanDiskProjects();
      for (const dp of diskProjects) {
        if (!this.engines.has(dp.id)) {
          result.push(dp);
        }
      }
    }

    return result;
  }

  /** Check if a project is running */
  isRunning(projectId: string): boolean {
    return this.engines.has(projectId);
  }

  /**
   * Scan ~/.deepforge/projects/ for recoverable projects.
   * Returns projects whose phase is NOT completed/paused (i.e., they were interrupted).
   * Does NOT auto-run them — caller decides whether to resume.
   */
  recoverFromDisk(): DiskProject[] {
    const recoverable: DiskProject[] = [];
    const all = this.scanDiskProjects();

    for (const dp of all) {
      // Skip already-loaded engines
      if (this.engines.has(dp.id)) continue;

      // Only recoverable if phase indicates mid-execution
      const phase = dp.state.phase;
      if (phase !== 'completed' && phase !== 'paused') {
        recoverable.push(dp);
        console.log(fmtLog(dp.id, `Recoverable project found — phase: ${phase}, iteration: ${dp.state.currentIteration}`));
      }
    }

    if (recoverable.length > 0) {
      console.log(fmtLog('system', `Found ${recoverable.length} recoverable project(s) on disk`));
    }

    return recoverable;
  }

  /**
   * Resume a project from disk. Loads the state and starts the engine.
   * Requires the original ForgeProject config (from forge-project.json or caller).
   */
  async resume(project: ForgeProject): Promise<string> {
    if (this.engines.has(project.id)) {
      throw new Error(`Project ${project.id} is already running`);
    }

    const statePath = join(this.projectsRoot, project.id, 'forge-state.json');
    if (!existsSync(statePath)) {
      throw new Error(`No state file found for project ${project.id}`);
    }

    console.log(fmtLog(project.id, 'Resuming from disk...'));
    return this.start(project);
  }

  /** Scan all project directories on disk */
  private scanDiskProjects(): DiskProject[] {
    const results: DiskProject[] = [];

    if (!existsSync(this.projectsRoot)) return results;

    let entries: string[];
    try {
      entries = readdirSync(this.projectsRoot);
    } catch {
      return results;
    }

    for (const entry of entries) {
      const projectDir = join(this.projectsRoot, entry);
      try {
        if (!statSync(projectDir).isDirectory()) continue;
      } catch { continue; }

      const statePath = join(projectDir, 'forge-state.json');
      if (!existsSync(statePath)) continue;

      try {
        const state: ForgeState = JSON.parse(readFileSync(statePath, 'utf-8'));
        results.push({
          id: state.projectId || entry,
          state,
          projectPath: projectDir,
          source: 'disk',
        });
      } catch {
        // Corrupt state file, skip
        console.warn(fmtLog(entry, 'Corrupt forge-state.json, skipping'));
      }
    }

    return results;
  }
}
