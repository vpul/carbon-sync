import type { Connection, Transport } from '@carbon-sync/engine';
import { type ClientMessage, parseServerMessage, type ServerMessage } from '@carbon-sync/protocol';

/** `<url>/v1/vaults/<vault>/ws`, mapping http(s) to ws(s). */
export function vaultSocketUrl(baseUrl: string, vault: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`server url must be http(s), got ${url.protocol}`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/vaults/${vault}/ws`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export interface WsTransportOptions {
  /** Observes every socket close, including the engine's reconnect cycles. */
  onCloseCode?: (code: number) => void;
}

class SocketConnection implements Connection {
  private messageHandler: ((message: ServerMessage) => void) | null = null;
  private closeHandler: ((code: number) => void) | null = null;
  private readonly buffered: ServerMessage[] = [];
  private closeCode: number | null = null;

  constructor(
    private readonly socket: WebSocket,
    onCloseCode: ((code: number) => void) | undefined,
  ) {
    socket.addEventListener('message', (event) => {
      let raw: string;
      if (typeof event.data === 'string') {
        raw = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        raw = new TextDecoder().decode(event.data);
      } else {
        return;
      }
      let message: ServerMessage;
      try {
        message = parseServerMessage(raw);
      } catch {
        // Never trust the wire: drop frames that fail validation.
        return;
      }
      if (this.messageHandler === null) {
        this.buffered.push(message);
      } else {
        this.messageHandler(message);
      }
    });
    socket.addEventListener('close', (event) => {
      this.closeCode = event.code;
      onCloseCode?.(event.code);
      this.closeHandler?.(event.code);
    });
  }

  send(message: ClientMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('websocket is not open');
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    try {
      this.socket.close(1000, 'client shutdown');
    } catch {
      // Already closing or closed.
    }
  }

  onMessage(callback: (message: ServerMessage) => void): void {
    this.messageHandler = callback;
    for (const message of this.buffered.splice(0)) {
      callback(message);
    }
  }

  onClose(callback: (code: number) => void): void {
    this.closeHandler = callback;
    if (this.closeCode !== null) {
      callback(this.closeCode);
    }
  }
}

/** `Transport` over Node's global WebSocket. */
export class WsTransport implements Transport {
  private readonly onCloseCode: ((code: number) => void) | undefined;

  constructor(options: WsTransportOptions = {}) {
    this.onCloseCode = options.onCloseCode;
  }

  async connect(url: string): Promise<Connection> {
    return await new Promise<Connection>((resolve, reject) => {
      const socket = new WebSocket(url);
      const onOpen = (): void => {
        socket.removeEventListener('error', onError);
        resolve(new SocketConnection(socket, this.onCloseCode));
      };
      const onError = (): void => {
        socket.removeEventListener('open', onOpen);
        reject(new Error(`failed to connect to ${url}`));
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
  }
}
