/**
 * DSH client 半（浏览器 classic script）的最小类型声明，手写。
 * 依据：DSH 桌面版 0.2.1-rc.5，见 docs/runtime/0.2.1-rc.5.md
 */
declare namespace DSH {
  type ClientRequire = (id: string) => any;

  interface SlotRegistration {
    id: string;
    order?: number;
    [key: string]: unknown;
  }

  interface ClientContext {
    slots: {
      inject(slot: string, factory: () => unknown): void;
      register(entry: SlotRegistration): unknown;
    };
    locale?: unknown;
    connection?: unknown;
    [service: string]: unknown;
  }

  interface ClientModule {
    inject?: string[];
    apply?: (ctx: ClientContext) => void;
  }

  interface ModuleLoader {
    load(definition: {
      id: string;
      factory: (require: ClientRequire) => ClientModule | undefined;
    }): void;
  }
}

interface Window {
  __ModuleLoader__: DSH.ModuleLoader;
}
