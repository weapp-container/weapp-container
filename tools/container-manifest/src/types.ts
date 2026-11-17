/** JSON objects are validated by the packer's schema/semantic checks. */
export type JsonObject = Record<string, any>
export interface Diagnostic { severity: 'error' | 'warning'; code: string; message: string; path?: string; details?: unknown }
export type CapabilityStatus = 'full' | 'partial' | 'unsupported'
export type CapabilityOverrides = Record<string, CapabilityStatus | { status: CapabilityStatus }> | { capabilities: Record<string, CapabilityStatus | { status: CapabilityStatus }> }
export interface PackOptions { compilerCommit?: string | undefined; platform?: string | undefined; project?: string | undefined; configFile?: string | undefined; resolveRoot?: string | undefined; capabilities?: CapabilityOverrides | undefined }
export interface Route { id: string; path: string; kind: string; entryModule: string; config?: string }
export interface WxmlDirectives { ifExpr?: string; elifExpr?: string; forExpr?: string; forKey?: string; forItem?: string; forIndex?: string; elseBranch?: boolean; events?: Record<string, string> }
export type WxmlNode = { kind: 'element'; tag: string; attrs: Record<string, string>; bindings: string[]; directives?: WxmlDirectives; boundValues?: Record<string, unknown>; children: WxmlNode[] } | { kind: 'text'; value: string; bindings: string[] } | { kind: 'comment'; value: string; bindings?: string[] }
export interface WxmlDocument { version: number; nodes: WxmlNode[] }
export interface CssDeclaration { property: string; value: string; important: boolean }
export interface CssRule { selectors: string[]; declarations: CssDeclaration[]; nested: CssRule[]; atRule?: string }
export interface ViewExpression { source: string; shorthand: boolean }
export interface ViewDocument { documentId: string; wxmlAst: string; ast: WxmlDocument; expressions: ViewExpression[] }
export interface ViewScript { id: string; sha256: string; dependencies: string[] }
export interface Manifest {
  schemaVersion: number; protocolVersion: string; compiler: { name: string; commit: string; platform: string };
  app: { appJson: string; entryModule: string }; routes: Route[];
  modules: { id: string; sha256: string; format: string; scope: string; dependencies?: string[] }[];
  templates: { id: string; wxmlAst: string; bindings: string[]; wxsModules?: Record<string, string> }[];
  styles: { id: string; wxssIr: string; scope: string }[];
  components: { id: string; owner: string; usingComponents: Record<string, string>; multipleSlots?: boolean }[];
  assets: { path: string; sha256: string; mime: string; size: number }[];
  capabilities: Record<string, CapabilityStatus>; integrity: { algorithm: string; root: string };
  viewScripts?: ViewScript[]; viewCompilation?: JsonObject; modernView?: JsonObject; rendering?: JsonObject;
}
export interface BuildResult { manifest: Manifest | null; blobs: Map<string, Buffer>; diagnostics: Diagnostic[]; appJsonSource?: string; watchDependencies?: { path: string; sha256: string }[] }
/** Error payloads from fs, parsers and bundlers share this diagnostic shape. */
export function errorInfo(value: unknown): Error & { code?: string; path?: string; location?: unknown; loc?: { line: number; column: number }; diagnostics?: Diagnostic[] } {
  return value instanceof Error ? value : new Error(String(value))
}
