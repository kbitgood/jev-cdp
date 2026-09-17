import type { ChromeTarget } from "./types";

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface CdpEnvelope {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

export async function listChromeTargets(cdpUrl: string): Promise<ChromeTarget[]> {
  const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/list`);
  if (!response.ok) throw new Error(`Chrome target list returned HTTP ${response.status}`);
  return (await response.json()) as ChromeTarget[];
}

async function browserWebSocketUrl(cdpUrl: string): Promise<string> {
  const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`);
  if (!response.ok) throw new Error(`Chrome DevTools endpoint returned HTTP ${response.status}`);
  const data = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) throw new Error("Chrome did not publish a browser WebSocket URL");
  return data.webSocketDebuggerUrl;
}

export class CdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingCommand>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpEnvelope;
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("Chrome CDP connection closed"));
      this.#pending.clear();
    });
  }

  static async connect(cdpUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(await browserWebSocketUrl(cdpUrl));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to Chrome CDP")), 5_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Could not connect to Chrome CDP"));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  command<T extends object = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.#socket.close();
  }
}
