/**
 * Agent-facing Mini App runtime authoring declarations.
 *
 * Copied from the miniapp-creator Skill for type checking only. It contains no Host
 * implementation; the Host injects runtime values through start(context).
 */
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

declare const HOST_CONNECTOR_TOOL_REF: unique symbol;
export type HostConnectorToolRef = string & {
  readonly [HOST_CONNECTOR_TOOL_REF]: 'HostConnectorToolRef';
};

export interface HostConnectorTool {
  readonly toolRef: HostConnectorToolRef;
  readonly provider: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
  readonly outputSchema?: JsonValue;
}

export interface HostConnectorListResult {
  readonly tools: readonly HostConnectorTool[];
  readonly partial: boolean;
}

export interface HostConnectorCallOptions {
  readonly signal?: AbortSignal;
}

export interface HostConnectorCallResult {
  readonly invocationId: string;
  readonly value: JsonValue;
}

export interface HostConnectorClient {
  list(options?: HostConnectorCallOptions): Promise<HostConnectorListResult>;
  call(
    toolRef: HostConnectorToolRef,
    arguments_: JsonObject,
    options?: HostConnectorCallOptions,
  ): Promise<HostConnectorCallResult>;
}

export interface MiniAppLogger {
  debug(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
}

export interface MiniAppLifecycle {
  dispose(): void | Promise<void>;
}

export interface MiniAppContext {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly dataDir: string;
  readonly listen: Readonly<{ readonly host: '127.0.0.1'; readonly port: number }>;
  readonly signal: AbortSignal;
  readonly logger: MiniAppLogger;
  readonly hostConnector?: HostConnectorClient;
}

export interface MiniAppModule {
  start(context: MiniAppContext): Promise<void | MiniAppLifecycle>;
}
