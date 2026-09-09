declare module "turndown" {
  export default class TurndownService {
    constructor(options?: Record<string, unknown>);
    addRule(key: string, rule: Record<string, unknown>): this;
    keep(filter: unknown): this;
    remove(filter: unknown): this;
    use(plugin: unknown): this;
    turndown(input: string): string;
  }
}

declare module "turndown-plugin-gfm" {
  export const gfm: unknown;
  export const tables: unknown;
  export const strikethrough: unknown;
  export const taskListItems: unknown;
}
