import type { DatabaseSync, SQLInputValue, StatementResultingChanges } from 'node:sqlite'
import type { IncomingHttpHeaders } from 'node:http'

/** Input objects remain untrusted until the service's field validators run. */
export type Input = Record<string, any>
export type HeadersInput = IncomingHttpHeaders | Headers
export interface AuthorizationPolicy { purpose: string; permissionVersion: string }
export interface ApplicationConfig {
  miniAppId: string; hostAppId: string; tenantId: string; environment: string;
  clientId: string; clientSecret: string; trustedPackRoots: string[];
  publisherId?: string; identityProtocol?: string;
  authorizationPolicies?: Record<string, AuthorizationPolicy>;
}
export interface HostServicesConfig {
  identitySecret: string; issuerSecret: string; database?: string;
  applications?: ApplicationConfig[]; payments?: Record<string, Input>;
}
export interface ProviderOptions { now?: () => number; fetch?: typeof globalThis.fetch }
export interface PaymentProvider {
  create(order: Input): Promise<{ launch: Input; status: string }>;
  query(order: Input): Promise<Input | undefined>;
  notification(headers: HeadersInput, raw: string): Input;
  validate(order: Input, event: Input): void;
}
export interface ServiceOptions extends ProviderOptions { providers?: Record<string, PaymentProvider> }
/** SQL columns are interpreted at each query, then JSON records are validated
 * by the same service checks used for HTTP input. Keep this boundary local. */
export type RecordDatabase = Omit<DatabaseSync, 'prepare'> & {
  prepare(sql: string): {
    get(...values: SQLInputValue[]): Input | undefined;
    all(...values: SQLInputValue[]): Input[];
    run(...values: SQLInputValue[]): StatementResultingChanges;
  };
}
