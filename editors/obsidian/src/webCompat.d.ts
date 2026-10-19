// Shared web modules are type-checked with the plugin; declare the Vite globals
// they reference (the plugin bundle never reads them at runtime).
interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
}
interface ImportMeta {
  readonly env: ImportMetaEnv & { readonly DEV: boolean; readonly PROD: boolean };
}
