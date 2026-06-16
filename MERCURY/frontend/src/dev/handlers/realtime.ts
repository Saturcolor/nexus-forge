/** Remplace WebSocket : /v1/realtime → stub sans connexion réseau (tests console). */

export function createWebSocketPatcher(Original: typeof WebSocket): typeof WebSocket {
  const Patched = new Proxy(Original, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const raw = args[0]
      const href = typeof raw === 'string' ? raw : raw instanceof URL ? raw.href : String(raw)
      if (!href.includes('/v1/realtime')) {
        return new target(...args)
      }
      let onopen: ((this: WebSocket, ev: Event) => void) | null = null
      let onmessage: ((this: WebSocket, ev: MessageEvent) => void) | null = null
      let onerror: ((this: WebSocket, ev: Event) => void) | null = null
      let onclose: ((this: WebSocket, ev: CloseEvent) => void) | null = null
      const stub = {
        url: href,
        readyState: WebSocket.CONNECTING,
        protocol: '',
        extensions: '',
        binaryType: 'blob' as BinaryType,
        bufferedAmount: 0,
        CONNECTING: WebSocket.CONNECTING,
        OPEN: WebSocket.OPEN,
        CLOSING: WebSocket.CLOSING,
        CLOSED: WebSocket.CLOSED,
        get onopen() {
          return onopen
        },
        set onopen(v) {
          onopen = v
        },
        get onmessage() {
          return onmessage
        },
        set onmessage(v) {
          onmessage = v
        },
        get onerror() {
          return onerror
        },
        set onerror(v) {
          onerror = v
        },
        get onclose() {
          return onclose
        },
        set onclose(v) {
          onclose = v
        },
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          void data
        },
        close(code?: number, reason?: string) {
          void code
          void reason
          Object.assign(stub, { readyState: WebSocket.CLOSED })
          onclose?.call(stub as unknown as WebSocket, new CloseEvent('close'))
        },
        addEventListener: EventTarget.prototype.addEventListener.bind({} as EventTarget),
        removeEventListener: EventTarget.prototype.removeEventListener.bind({} as EventTarget),
        dispatchEvent: EventTarget.prototype.dispatchEvent.bind({} as EventTarget),
      } as unknown as WebSocket
      queueMicrotask(() => {
        Object.assign(stub, { readyState: WebSocket.OPEN })
        onopen?.call(stub, new Event('open'))
        onmessage?.call(
          stub,
          new MessageEvent('message', { data: JSON.stringify({ type: 'mock.ping', mock: true }) }),
        )
      })
      return stub
    },
  })
  return Patched as unknown as typeof WebSocket
}
