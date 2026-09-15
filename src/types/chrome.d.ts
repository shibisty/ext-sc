// Minimal, hand-written ambient types for the WebExtension APIs this
// project actually calls (via the `chrome.*` namespace — see src/shim.ts
// for why that also covers Firefox). This intentionally isn't a full
// mirror of @types/chrome: it only declares what's used, so it doubles as
// documentation of the extension's real API surface, and needs no network
// access to install.
//
// All async methods are typed Promise-returning only (no callback
// overloads) because every call site in this codebase uses `await`/`.then`
// — see README.md "Cross-browser compatibility" for why that's safe in
// both Chrome (MV3 supports promises) and Firefox (via the shim).

declare namespace chrome {
  namespace runtime {
    interface LastError {
      message?: string;
    }
    // Present (possibly undefined) only while a callback-style API call is
    // resolving; not used by this codebase's promise-style calls except
    // where chrome.tabCapture's callback API is invoked directly.
    let lastError: LastError | undefined;

    interface MessageSender {
      tab?: chrome.tabs.Tab;
      id?: string;
    }

    type MessageListener = (
      message: any,
      sender: MessageSender,
      sendResponse: (response?: any) => void
    ) => boolean | void;

    function sendMessage<T = any>(message: any): Promise<T>;
    function getURL(path: string): string;
    function getContexts(filter: { contextTypes: string[] }): Promise<Array<{ contextType: string }>>;
    function getManifest(): Record<string, any>;

    namespace onMessage {
      function addListener(callback: MessageListener): void;
      function removeListener(callback: MessageListener): void;
    }
    namespace onInstalled {
      function addListener(callback: () => void | Promise<void>): void;
    }
  }

  namespace storage {
    interface StorageArea {
      get<T = Record<string, any>>(keys?: string | string[] | Record<string, any> | null): Promise<T>;
      set(items: Record<string, any>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
    const sync: StorageArea;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      url?: string;
      title?: string;
      active?: boolean;
      discarded?: boolean;
    }
    interface TabChangeInfo {
      status?: "loading" | "complete";
      url?: string;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function create(properties: { url: string }): Promise<Tab>;
    function update(tabId: number, properties: { active?: boolean }): Promise<Tab>;
    function sendMessage<T = any>(tabId: number, message: any): Promise<T>;
    function captureVisibleTab(windowId: number, options: { format: "png" | "jpeg" }): Promise<string>;
    namespace onUpdated {
      function addListener(
        callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void | Promise<void>
      ): void;
    }
    namespace onRemoved {
      function addListener(callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void | Promise<void>): void;
    }
  }

  namespace windows {
    interface Window {
      id?: number;
      focused?: boolean;
    }
    function getCurrent(): Promise<Window>;
    function getAll(): Promise<Window[]>;
    function create(properties: {
      url?: string;
      type?: "popup" | "normal";
      width?: number;
      height?: number;
      focused?: boolean;
      state?: "minimized" | "maximized" | "normal";
    }): Promise<Window>;
    function update(windowId: number, properties: { focused?: boolean }): Promise<Window>;
    namespace onRemoved {
      function addListener(callback: (windowId: number) => void | Promise<void>): void;
    }
  }

  namespace downloads {
    interface DownloadItem {
      id: number;
      state?: "in_progress" | "interrupted" | "complete";
      exists?: boolean;
    }
    function download(options: { url: string; filename: string; saveAs?: boolean }): Promise<number>;
    function search(query: { id: number }): Promise<DownloadItem[]>;
    function show(downloadId: number): void;
    function open(downloadId: number): void;
  }

  namespace notifications {
    function create(options: {
      type: "basic";
      iconUrl: string;
      title: string;
      message: string;
    }): void;
  }

  namespace action {
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    function setBadgeText(details: { text: string }): Promise<void>;
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number;
    }
    interface ExecutionResult<T = any> {
      result: T;
    }
    // func may return T directly or a Promise<T> — the real API awaits a
    // returned promise before setting `.result`, which this codebase relies
    // on (e.g. an injected async clipboard-write helper).
    function executeScript<Args extends any[], T = any>(injection: {
      target: InjectionTarget;
      files?: string[];
      func?: (...args: Args) => T | Promise<T>;
      args?: Args;
    }): Promise<Array<ExecutionResult<T>>>;
  }

  namespace commands {
    interface Command {
      name?: string;
      shortcut?: string;
    }
    function getAll(): Promise<Command[]>;
    namespace onCommand {
      function addListener(callback: (command: string) => void | Promise<void>): void;
    }
  }

  namespace offscreen {
    type Reason = "USER_MEDIA" | "DISPLAY_MEDIA" | "CLIPBOARD";
    function createDocument(options: { url: string; reasons: Reason[]; justification: string }): Promise<void>;
    function closeDocument(): Promise<void>;
    function hasDocument(): Promise<boolean>;
  }

  namespace tabCapture {
    function getMediaStreamId(
      options: { targetTabId: number },
      callback: (streamId: string) => void
    ): void;
  }

  namespace sidePanel {
    function open(options: { windowId: number }): Promise<void>;
    function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
  }

  // Firefox only (reached through the chrome=browser alias — see shim.ts).
  namespace sidebarAction {
    function open(): Promise<void>;
  }

  // Firefox only (reached through the chrome=browser alias — see shim.ts).
  // A privileged WebExtension API that writes an image straight to the OS
  // clipboard from any extension page, including the background page —
  // unlike navigator.clipboard.write(), it has no document-focus
  // requirement. Requires the "clipboardWrite" manifest permission.
  namespace clipboard {
    function setImageData(imageData: ArrayBuffer, imageType: "png" | "jpeg"): Promise<void>;
  }

  namespace i18n {
    function getUILanguage(): string;
  }
}
