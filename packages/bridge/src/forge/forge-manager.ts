/**
 * Forge Manager — Manages multiple ForgeEngine instances.
 * Provides start/stop/status/list API for gateway integration.
 */
import { ForgeEngine } from './forge-engine.js';
import type { ForgeProject, ForgeState } from './types.js';

export class ForgeManager {
  private engines = new Map<string, ForgeEngine>();

  /** Start a new forge project */
  async start(project: ForgeProject): Promise<string> {
    if (this.engines.has(project.id)) {
      throw new Error(`Project ${project.id} is already running`);
    }

    const engine = new ForgeEngine(project, {
      log: (msg) => console.log(`[forge:${project.id}] ${msg}`),
    });

    this.engines.set(project.id, engine);

    // Run in background (non-blocking)
    engine.run().then(() => {
      console.log(`[forge:${project.id}] Completed`);
    }).catch((err) => {
      console.error(`[forge:${project.id}] Fatal:`, err);
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

  /** Get status of a project */
  status(projectId: string): ForgeState | null {
    const engine = this.engines.get(projectId);
    return engine?.currentState ?? null;
  }

  /** List all running projects */
  list(): Array<{ id: string; state: ForgeState }> {
    const result: Array<{ id: string; state: ForgeState }> = [];
    for (const [id, engine] of this.engines) {
      result.push({ id, state: engine.currentState });
    }
    return result;
  }

  /** Check if a project is running */
  isRunning(projectId: string): boolean {
    return this.engines.has(projectId);
  }
}
