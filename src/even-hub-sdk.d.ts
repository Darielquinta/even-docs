declare module '@evenrealities/even_hub_sdk' {
  export function waitForEvenAppBridge(): Promise<any>
  export class TextContainerProperty {
    constructor(args: Record<string, unknown>)
  }
  export class CreateStartUpPageContainer {
    constructor(args: Record<string, unknown>)
  }
  export class RebuildPageContainer {
    constructor(args: Record<string, unknown>)
  }
  export class TextContainerUpgrade {
    constructor(args: Record<string, unknown>)
  }
  export const OsEventTypeList: Record<string, string | number>
}
