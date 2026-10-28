import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FooterSettings } from "./footer-settings.js";

const execFileAsync = promisify(execFile);

type GitOptions = Pick<FooterSettings, "gitRefreshSeconds" | "gitFetch" | "gitFetchTimeoutSeconds">;

/** Owns Git divergence state and all background work associated with a live footer. */
export class GitStatus {
  private cwd: string;
  private syncValue = "";
  private initialized = false;
  private highlightedValue = false;
  private requestGeneration = 0;
  private lifecycleGeneration = 0;
  private active = false;
  private requestRender: (() => void) | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private fetchController: AbortController | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  get sync(): string { return this.syncValue; }
  get highlighted(): boolean { return this.highlightedValue; }

  setCwd(cwd: string): void {
    if (this.cwd === cwd) return;
    this.cwd = cwd;
    this.requestGeneration++;
    this.syncValue = "";
    this.initialized = false;
    this.clearPulse();
    this.fetchController?.abort();
    this.fetchController = null;
  }

  start(options: GitOptions, requestRender: () => void): void {
    this.stop();
    this.active = true;
    const lifecycle = ++this.lifecycleGeneration;
    this.requestRender = requestRender;
    const pollMs = (options.gitRefreshSeconds ?? 91) * 1000;
    const schedulePoll = () => {
      if (!this.isCurrent(lifecycle)) return;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        void this.refresh().finally(() => {
          if (this.isCurrent(lifecycle)) requestRender();
          schedulePoll();
        });
      }, pollMs);
      this.pollTimer.unref?.();
    };
    schedulePoll();
    if (options.gitFetch === true) this.startFetchLoop(options.gitFetchTimeoutSeconds ?? 17, lifecycle);
  }

  stop(): void {
    this.active = false;
    this.lifecycleGeneration++;
    this.requestGeneration++;
    this.requestRender = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = null;
    this.fetchController?.abort();
    this.fetchController = null;
    this.clearPulse();
  }

  async refresh(): Promise<void> {
    if (!this.active) return;
    const cwd = this.cwd;
    const lifecycle = this.lifecycleGeneration;
    const request = ++this.requestGeneration;
    const sync = await this.query(cwd);
    if (!this.isCurrent(lifecycle) || cwd !== this.cwd || request !== this.requestGeneration) return;
    const changed = this.initialized && this.syncValue !== sync;
    this.syncValue = sync;
    this.initialized = true;
    if (changed) this.pulse(lifecycle);
  }

  private isCurrent(lifecycle: number): boolean {
    return this.active && this.lifecycleGeneration === lifecycle;
  }

  private async query(cwd: string): Promise<string> {
    try {
      // Keep Git asynchronous and outside render(); absent upstreams are intentionally hidden.
      const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], {
        timeout: 1000,
        maxBuffer: 1024,
      });
      const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return "";
      return `${ahead ? ` ↑${ahead}` : ""}${behind ? ` ↓${behind}` : ""}`;
    } catch {
      return "";
    }
  }

  private pulse(lifecycle: number): void {
    this.clearPulse();
    this.highlightedValue = true;
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = null;
      if (!this.isCurrent(lifecycle)) return;
      this.highlightedValue = false;
      this.requestRender?.();
    }, 1000);
    this.pulseTimer.unref?.();
  }

  private clearPulse(): void {
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = null;
    this.highlightedValue = false;
  }

  private startFetchLoop(timeoutSeconds: number, lifecycle: number): void {
    const fetchGit = async (): Promise<void> => {
      if (!this.isCurrent(lifecycle)) return;
      const cwd = this.cwd;
      const controller = new AbortController();
      this.fetchController = controller;
      try {
        // Never prompt for credentials in a background job; retry jitter spreads sessions.
        await execFileAsync("git", ["-C", cwd, "fetch", "--quiet"], {
          timeout: timeoutSeconds * 1000,
          signal: controller.signal,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
        });
        if (this.isCurrent(lifecycle) && !controller.signal.aborted && this.cwd === cwd) {
          await this.refresh();
          if (this.isCurrent(lifecycle)) this.requestRender?.();
        }
      } catch {
        // Offline, authentication, timeout and cancellation failures are silent.
      } finally {
        if (this.fetchController === controller) this.fetchController = null;
        if (this.isCurrent(lifecycle)) {
          this.fetchTimer = setTimeout(() => {
            this.fetchTimer = null;
            void fetchGit();
          }, 5 * 60 * 1000 * (1 + (Math.random() * 2 - 1) / 8));
          this.fetchTimer.unref?.();
        }
      }
    };
    void fetchGit();
  }
}
