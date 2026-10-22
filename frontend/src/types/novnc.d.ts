declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>)
    scaleViewport: boolean
    resizeSession: boolean
    viewOnly: boolean
    focusOnClick: boolean
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    focus(options?: FocusOptions): void
    sendCtrlAltDel(): void
    sendKey(keysym: number, code?: string, down?: boolean): void
    clipboardPasteFrom(text: string): void
  }
}
