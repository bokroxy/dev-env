/** Type-only description of rpiv-todo's optional peer; nothing is installed or enabled. */
declare module "@juicesharp/rpiv-i18n" {
  export function scope(
    namespace: string,
  ): (key: string, fallback: string) => string;
}
declare module "@juicesharp/rpiv-i18n/loader" {
  export function registerLocalesFromDir(
    namespace: string,
    packageUrl: string,
    options?: { label?: string },
  ): void;
}
