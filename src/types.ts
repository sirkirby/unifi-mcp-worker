// src/types.ts
// All TypeScript interfaces and constants for the UniFi MCP relay worker.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;
export const TOOL_CALL_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_ACK_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Environment (Cloudflare bindings)
// ---------------------------------------------------------------------------

export interface Env {
  RELAY: DurableObjectNamespace;
  AGENT_TOKEN: string;
  ADMIN_TOKEN: string;
  TOOL_REGISTRATION_MODE: string;
}

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  serverOrigin?: string;
}

// ---------------------------------------------------------------------------
// WebSocket messages — relay client → worker (inbound)
// ---------------------------------------------------------------------------

export interface RegisterMessage {
  type: "register";
  protocol_version: number;
  token: string;
  location_name: string;
  tools: ToolInfo[];
  capabilities: string[];
}

export interface ToolCallResponse {
  type: "tool_result";
  call_id: string;
  result?: unknown;
  error?: string;
}

export interface CatalogUpdateMessage {
  type: "catalog_update";
  tools: ToolInfo[];
  capabilities: string[];
}

export interface HeartbeatMessage {
  type: "heartbeat";
}

export type InboundMessage =
  | RegisterMessage
  | ToolCallResponse
  | CatalogUpdateMessage
  | HeartbeatMessage;

// ---------------------------------------------------------------------------
// WebSocket messages — worker → relay client (outbound)
// ---------------------------------------------------------------------------

export interface RegisteredMessage {
  type: "registered";
  location_id: string;
  location_name: string;
}

export interface ToolCallRequest {
  type: "tool_call";
  call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  timeout_ms: number;
}

export interface HeartbeatAckMessage {
  type: "heartbeat_ack";
}

export interface ErrorMessage {
  type: "error";
  message: string;
  code?: string;
}

export type OutboundMessage =
  | RegisteredMessage
  | ToolCallRequest
  | HeartbeatAckMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// MCP JSON-RPC
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: unknown;
}

// ---------------------------------------------------------------------------
// Durable Object internal state
// ---------------------------------------------------------------------------

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  locationId: string;
}

export interface LocationInfo {
  locationId: string;
  locationName: string;
  relayTokenHash: string;
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// Fan-out / aggregated responses
// ---------------------------------------------------------------------------

export interface FanOutResult {
  location_id: string;
  location_name: string;
  data?: unknown;
  error?: string;
}

export interface AggregatedResponse {
  success: boolean;
  results: FanOutResult[];
  partial: boolean;
  locations_total: number;
  locations_responded: number;
}
