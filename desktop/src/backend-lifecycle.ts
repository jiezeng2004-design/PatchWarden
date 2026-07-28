export interface BackendChild {
  kill(): unknown;
  once(event: "exit", listener: () => void): unknown;
  off?(event: "exit", listener: () => void): unknown;
}

export interface QuitCleanupCoordinator {
  isComplete(): boolean;
  run(): Promise<void>;
}

/** Keep bounded child-process diagnostics useful without persisting credentials. */
export function sanitizeStartupDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|secret|password|cookie)=)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&\s]+)/gi, "$1[REDACTED]")
    .replace(/\b(token|api[_-]?key|password|secret|cookie|authorization)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/gi, "$1$2[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mayStopOwnedServices(
  ownedChild: unknown,
  capturedChild: unknown,
  probeKind: string,
  hasMatchingDesktopInstance: boolean,
): boolean {
  return Boolean(ownedChild)
    && ownedChild === capturedChild
    && probeKind === "patchwarden"
    && hasMatchingDesktopInstance;
}

export function createQuitCleanupCoordinator(
  cleanup: () => Promise<void>,
): QuitCleanupCoordinator {
  let cleanupPromise: Promise<void> | null = null;
  let complete = false;
  return {
    isComplete: () => complete,
    run: () => {
      if (!cleanupPromise) {
        cleanupPromise = cleanup().finally(() => { complete = true; });
      }
      return cleanupPromise;
    },
  };
}

export async function stopBackendChild(
  child: BackendChild,
  timeoutMs: number = 5000,
): Promise<boolean> {
  return new Promise<boolean>((resolveStop) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (stopped: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off?.("exit", onExit);
      resolveStop(stopped);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      child.kill();
    } catch {
      // The child exited between ownership capture and kill.
      finish(true);
    }
  });
}

export function createSerializedRestartScheduler(
  restart: () => Promise<void>,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
): (delayMs?: number) => Promise<void> {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let latestDelayMs = 0;
  let worker: Promise<void> | null = null;

  return (delayMs: number = 0) => {
    requestedGeneration += 1;
    latestDelayMs = Math.max(latestDelayMs, Math.max(0, delayMs));
    if (!worker) {
      worker = (async () => {
        while (completedGeneration < requestedGeneration) {
          const delay = latestDelayMs;
          latestDelayMs = 0;
          await wait(delay);
          const targetGeneration = requestedGeneration;
          await restart();
          completedGeneration = targetGeneration;
        }
      })().finally(() => {
        worker = null;
      });
    }
    return worker;
  };
}
