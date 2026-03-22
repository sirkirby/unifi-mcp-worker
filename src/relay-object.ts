// src/relay-object.ts
import { DurableObject } from "cloudflare:workers";
import type { RelayStub } from "./mcp-handler";
import { handleMcpRequest } from "./mcp-handler";
import { hashToken, generateToken } from "./auth";
import type {
  Env,
  ToolInfo,
  ToolAnnotations,
  RegisterMessage,
  ToolCallResponse,
  CatalogUpdateMessage,
  InboundMessage,
  RegisteredMessage,
  ToolCallRequest,
  HeartbeatAckMessage,
  ErrorMessage,
  PendingRequest,
  FanOutResult,
  AggregatedResponse,
} from "./types";
import { PROTOCOL_VERSION, TOOL_CALL_TIMEOUT_MS } from "./types";

// ---------------------------------------------------------------------------
// Meta-tool definitions (virtual tools served by the relay itself)
// ---------------------------------------------------------------------------

const META_TOOL_INDEX: ToolInfo = {
  name: "unifi_tool_index",
  description:
    "List all available UniFi tools with descriptions and categories. " +
    "Use this to discover tools before calling unifi_execute.",
  inputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "Optional category filter (e.g., 'clients', 'devices', 'firewall')",
      },
      search: {
        type: "string",
        description: "Optional search term to filter tools by name or description",
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const META_TOOL_EXECUTE: ToolInfo = {
  name: "unifi_execute",
  description:
    "Execute a UniFi tool by name. Use unifi_tool_index to discover available tools first. " +
    "Pass the tool name and its arguments.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string", description: "Name of the tool to execute" },
      arguments: {
        type: "object",
        description: "Arguments to pass to the tool",
        additionalProperties: true,
      },
      __location: {
        type: "string",
        description: "Target location ID (required for multi-location write operations)",
      },
    },
    required: ["tool_name"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

const META_TOOL_BATCH: ToolInfo = {
  name: "unifi_batch",
  description:
    "Execute multiple UniFi tools in a single request. Each call is an object with " +
    "'tool_name' and 'arguments'. Results are returned in order.",
  inputSchema: {
    type: "object",
    properties: {
      calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            arguments: { type: "object", additionalProperties: true },
            __location: { type: "string" },
          },
          required: ["tool_name"],
        },
        description: "Array of tool calls to execute",
      },
    },
    required: ["calls"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

const META_TOOLS: ToolInfo[] = [META_TOOL_INDEX, META_TOOL_EXECUTE, META_TOOL_BATCH];

// ---------------------------------------------------------------------------
// Relay Durable Object
// ---------------------------------------------------------------------------

export class RelayObject extends DurableObject<Env> implements RelayStub {
  /** location_id -> list of tools registered by that location */
  private locationTools = new Map<string, ToolInfo[]>();
  /** tool_name -> list of location_ids that provide it */
  private toolToLocations = new Map<string, string[]>();
  /** call_id -> pending promise waiting for a tool_result */
  private pending = new Map<string, PendingRequest>();
  /** Whether in-memory state has been rebuilt from SQLite since last wake */
  private stateRebuilt = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(() => this.ensureTables());
  }

  // -------------------------------------------------------------------------
  // SQLite schema
  // -------------------------------------------------------------------------

  private async ensureTables(): Promise<void> {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS locations (
        location_id TEXT PRIMARY KEY,
        location_name TEXT NOT NULL,
        relay_token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS location_tools (
        location_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        input_schema TEXT,
        annotations TEXT,
        server_origin TEXT,
        PRIMARY KEY (location_id, tool_name),
        FOREIGN KEY (location_id) REFERENCES locations(location_id)
      );
    `);
  }

  // -------------------------------------------------------------------------
  // In-memory state rebuild from SQLite
  // -------------------------------------------------------------------------

  private rebuildInMemoryState(): void {
    this.locationTools.clear();
    this.toolToLocations.clear();

    // Load all tools grouped by location
    const rows = this.ctx.storage.sql.exec(
      `SELECT lt.location_id, lt.tool_name, lt.description, lt.input_schema, lt.annotations, lt.server_origin
       FROM location_tools lt
       JOIN locations l ON lt.location_id = l.location_id`,
    ).toArray();

    for (const row of rows) {
      const locationId = row.location_id as string;
      const tool: ToolInfo = {
        name: row.tool_name as string,
        description: (row.description as string) || "",
      };

      if (row.input_schema) {
        try {
          tool.inputSchema = JSON.parse(row.input_schema as string);
        } catch {
          // skip invalid schema
        }
      }
      if (row.annotations) {
        try {
          tool.annotations = JSON.parse(row.annotations as string) as ToolAnnotations;
        } catch {
          // skip invalid annotations
        }
      }
      if (row.server_origin) {
        tool.serverOrigin = row.server_origin as string;
      }

      // Add to locationTools
      if (!this.locationTools.has(locationId)) {
        this.locationTools.set(locationId, []);
      }
      this.locationTools.get(locationId)!.push(tool);

      // Add to toolToLocations
      if (!this.toolToLocations.has(tool.name)) {
        this.toolToLocations.set(tool.name, []);
      }
      const locs = this.toolToLocations.get(tool.name)!;
      if (!locs.includes(locationId)) {
        locs.push(locationId);
      }
    }

    this.stateRebuilt = true;
  }

  // -------------------------------------------------------------------------
  // HTTP fetch handler
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (!this.stateRebuilt) {
      this.rebuildInMemoryState();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/ws") {
      return this.handleWebSocketUpgrade(request);
    }
    if (path === "/mcp" && request.method === "POST") {
      return this.handleMcp(request);
    }
    if (path === "/api/locations" && request.method === "GET") {
      return this.handleGetLocations();
    }
    if (path === "/api/locations/token" && request.method === "POST") {
      return this.handleGenerateToken(request);
    }
    if (path === "/tools" && request.method === "GET") {
      return this.handleGetTools();
    }

    return new Response("Not found", { status: 404 });
  }

  // -------------------------------------------------------------------------
  // WebSocket upgrade
  // -------------------------------------------------------------------------

  private handleWebSocketUpgrade(request: Request): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept with hibernation API
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // -------------------------------------------------------------------------
  // MCP handler
  // -------------------------------------------------------------------------

  private async handleMcp(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as import("./types").JsonRpcRequest;
      const mode = this.env.TOOL_REGISTRATION_MODE || "lazy";
      const result = await handleMcpRequest(body, this, mode);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ error: "Invalid request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Admin: GET /api/locations
  // -------------------------------------------------------------------------

  private handleGetLocations(): Response {
    const rows = this.ctx.storage.sql.exec(
      `SELECT location_id, location_name, created_at, last_seen FROM locations ORDER BY location_name`,
    ).toArray();

    // Determine which locations are currently connected via WebSocket
    const connectedLocationIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment() as { locationId?: string } | null;
        if (attachment?.locationId) {
          connectedLocationIds.add(attachment.locationId);
        }
      } catch {
        // skip websockets without valid attachment
      }
    }

    const locations = rows.map((row) => ({
      location_id: row.location_id as string,
      location_name: row.location_name as string,
      created_at: row.created_at as number,
      last_seen: row.last_seen as number,
      connected: connectedLocationIds.has(row.location_id as string),
    }));

    return new Response(JSON.stringify({ locations }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // -------------------------------------------------------------------------
  // Admin: POST /api/locations/token
  // -------------------------------------------------------------------------

  private async handleGenerateToken(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const locationName = body.location_name as string | undefined;
    if (!locationName || typeof locationName !== "string") {
      return new Response(JSON.stringify({ error: "Missing location_name" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const token = generateToken();
    const tokenHash = await hashToken(token);
    const locationId = crypto.randomUUID();
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT INTO locations (location_id, location_name, relay_token_hash, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(location_id) DO UPDATE SET
         location_name = excluded.location_name,
         relay_token_hash = excluded.relay_token_hash,
         last_seen = excluded.last_seen`,
      locationId,
      locationName,
      tokenHash,
      now,
      now,
    );

    return new Response(
      JSON.stringify({
        location_id: locationId,
        location_name: locationName,
        token,
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Internal: GET /tools
  // -------------------------------------------------------------------------

  private handleGetTools(): Response {
    const tools = this.getAggregatedTools();
    return new Response(JSON.stringify({ tools }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket Hibernation API handlers
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);

    let parsed: InboundMessage;
    try {
      parsed = JSON.parse(raw) as InboundMessage;
    } catch {
      this.sendWs(ws, { type: "error", message: "Invalid JSON", code: "PARSE_ERROR" });
      return;
    }

    switch (parsed.type) {
      case "register":
        await this.handleRegister(ws, parsed as RegisterMessage);
        break;
      case "tool_result":
        this.handleToolResult(parsed as ToolCallResponse);
        break;
      case "catalog_update":
        this.handleCatalogUpdate(ws, parsed as CatalogUpdateMessage);
        break;
      case "heartbeat":
        this.sendWs(ws, { type: "heartbeat_ack" });
        break;
      default:
        this.sendWs(ws, {
          type: "error",
          message: `Unknown message type: ${(parsed as Record<string, unknown>).type}`,
          code: "UNKNOWN_TYPE",
        });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.cleanupWebSocket(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.cleanupWebSocket(ws);
  }

  // -------------------------------------------------------------------------
  // WebSocket message handlers
  // -------------------------------------------------------------------------

  private async handleRegister(ws: WebSocket, msg: RegisterMessage): Promise<void> {
    // Validate protocol version
    if (msg.protocol_version !== PROTOCOL_VERSION) {
      this.sendWs(ws, {
        type: "error",
        message: `Unsupported protocol version: ${msg.protocol_version}, expected ${PROTOCOL_VERSION}`,
        code: "PROTOCOL_MISMATCH",
      });
      return;
    }

    // Hash the incoming token and look up matching location
    const incomingHash = await hashToken(msg.token);

    const rows = this.ctx.storage.sql.exec(
      `SELECT location_id, location_name, relay_token_hash FROM locations WHERE relay_token_hash = ?`,
      incomingHash,
    ).toArray();

    if (rows.length === 0) {
      this.sendWs(ws, {
        type: "error",
        message: "Invalid relay token",
        code: "AUTH_FAILED",
      });
      return;
    }

    const locationId = rows[0].location_id as string;
    const locationName = rows[0].location_name as string;
    const now = Date.now();

    // Update last_seen and location_name (sidecar may update its name)
    this.ctx.storage.sql.exec(
      `UPDATE locations SET last_seen = ?, location_name = ? WHERE location_id = ?`,
      now,
      msg.location_name || locationName,
      locationId,
    );

    // Replace tools for this location
    this.ctx.storage.sql.exec(`DELETE FROM location_tools WHERE location_id = ?`, locationId);

    for (const tool of msg.tools) {
      this.ctx.storage.sql.exec(
        `INSERT INTO location_tools (location_id, tool_name, description, input_schema, annotations, server_origin)
         VALUES (?, ?, ?, ?, ?, ?)`,
        locationId,
        tool.name,
        tool.description || "",
        tool.inputSchema ? JSON.stringify(tool.inputSchema) : null,
        tool.annotations ? JSON.stringify(tool.annotations) : null,
        tool.serverOrigin || null,
      );
    }

    // Rebuild in-memory state
    this.rebuildInMemoryState();

    // Attach location_id to the WebSocket for later identification
    ws.serializeAttachment({ locationId, locationName: msg.location_name || locationName });

    // Send confirmation
    const response: RegisteredMessage = {
      type: "registered",
      location_id: locationId,
      location_name: msg.location_name || locationName,
    };
    this.sendWs(ws, response);
  }

  private handleToolResult(msg: ToolCallResponse): void {
    const pending = this.pending.get(msg.call_id);
    if (!pending) {
      // Stale or duplicate result, ignore
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(msg.call_id);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleCatalogUpdate(ws: WebSocket, msg: CatalogUpdateMessage): void {
    const attachment = ws.deserializeAttachment() as { locationId?: string } | null;
    if (!attachment?.locationId) {
      this.sendWs(ws, {
        type: "error",
        message: "Must register before sending catalog updates",
        code: "NOT_REGISTERED",
      });
      return;
    }

    const locationId = attachment.locationId;

    // Replace tools for this location
    this.ctx.storage.sql.exec(`DELETE FROM location_tools WHERE location_id = ?`, locationId);

    for (const tool of msg.tools) {
      this.ctx.storage.sql.exec(
        `INSERT INTO location_tools (location_id, tool_name, description, input_schema, annotations, server_origin)
         VALUES (?, ?, ?, ?, ?, ?)`,
        locationId,
        tool.name,
        tool.description || "",
        tool.inputSchema ? JSON.stringify(tool.inputSchema) : null,
        tool.annotations ? JSON.stringify(tool.annotations) : null,
        tool.serverOrigin || null,
      );
    }

    // Rebuild in-memory state
    this.rebuildInMemoryState();

    // Update last_seen
    this.ctx.storage.sql.exec(
      `UPDATE locations SET last_seen = ? WHERE location_id = ?`,
      Date.now(),
      locationId,
    );
  }

  private cleanupWebSocket(ws: WebSocket): void {
    try {
      const attachment = ws.deserializeAttachment() as { locationId?: string } | null;
      if (attachment?.locationId) {
        // Location disconnected -- in-memory state stays (tools are still in SQLite)
        // but the location won't be routable until it reconnects.
        // We do NOT remove from locationTools since tools persist in SQLite.
      }
    } catch {
      // No attachment, nothing to clean up
    }
  }

  // -------------------------------------------------------------------------
  // RelayStub interface implementation
  // -------------------------------------------------------------------------

  async getToolList(mode: string): Promise<ToolInfo[]> {
    if (mode === "lazy" || mode === "meta_only") {
      return META_TOOLS;
    }

    // eager mode: return all deduplicated tools from all locations
    return this.getAggregatedTools();
  }

  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | AggregatedResponse> {
    // Handle meta-tools
    if (toolName === "unifi_tool_index") {
      return this.handleToolIndex(args);
    }
    if (toolName === "unifi_execute") {
      return this.handleExecute(args);
    }
    if (toolName === "unifi_batch") {
      return this.handleBatch(args);
    }

    // Direct tool call (eager mode)
    return this.routeToolCall(toolName, args);
  }

  async isMultiLocation(): Promise<boolean> {
    return this.locationTools.size > 1;
  }

  // -------------------------------------------------------------------------
  // Meta-tool handlers
  // -------------------------------------------------------------------------

  private handleToolIndex(args: Record<string, unknown>): Record<string, unknown> {
    const category = args.category as string | undefined;
    const search = args.search as string | undefined;

    // Build tool list with location metadata
    const toolEntries: Array<{
      name: string;
      description: string;
      locations: string[];
      annotations?: ToolAnnotations;
    }> = [];

    const seen = new Set<string>();
    for (const [locationId, tools] of this.locationTools) {
      for (const tool of tools) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          toolEntries.push({
            name: tool.name,
            description: tool.description,
            locations: this.toolToLocations.get(tool.name) || [locationId],
            annotations: tool.annotations,
          });
        }
      }
    }

    let filtered = toolEntries;

    // Filter by category (matches tools whose name or description contains the category)
    if (category) {
      const cat = category.toLowerCase();
      filtered = filtered.filter(
        (t) => t.name.toLowerCase().includes(cat) || t.description.toLowerCase().includes(cat),
      );
    }

    // Filter by search term
    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter(
        (t) => t.name.toLowerCase().includes(term) || t.description.toLowerCase().includes(term),
      );
    }

    return {
      success: true,
      data: {
        tools: filtered,
        total: filtered.length,
        multi_location: this.locationTools.size > 1,
      },
    };
  }

  private async handleExecute(args: Record<string, unknown>): Promise<Record<string, unknown> | AggregatedResponse> {
    const toolName = args.tool_name as string;
    if (!toolName) {
      return { success: false, error: "Missing required argument: tool_name" };
    }

    const toolArgs = (args.arguments as Record<string, unknown>) || {};
    const location = args.__location as string | undefined;
    if (location) {
      toolArgs.__location = location;
    }

    return this.routeToolCall(toolName, toolArgs);
  }

  private async handleBatch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const calls = args.calls as Array<{ tool_name: string; arguments?: Record<string, unknown>; __location?: string }>;
    if (!calls || !Array.isArray(calls)) {
      return { success: false, error: "Missing required argument: calls (array)" };
    }

    const results: Array<{ tool_name: string; result?: unknown; error?: string }> = [];

    for (const call of calls) {
      try {
        const callArgs = call.arguments || {};
        if (call.__location) {
          callArgs.__location = call.__location;
        }
        const result = await this.routeToolCall(call.tool_name, callArgs);
        results.push({ tool_name: call.tool_name, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        results.push({ tool_name: call.tool_name, error: msg });
      }
    }

    return { success: true, data: { results, total: results.length } };
  }

  // -------------------------------------------------------------------------
  // Tool call routing
  // -------------------------------------------------------------------------

  private async routeToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | AggregatedResponse> {
    const locations = this.toolToLocations.get(toolName);
    if (!locations || locations.length === 0) {
      return { success: false, error: `Tool not found: ${toolName}` };
    }

    // Single location: always route directly
    if (this.locationTools.size === 1) {
      const locationId = locations[0];
      return this.sendToolCall(locationId, toolName, args);
    }

    // Multi-location: check if the tool is read-only
    const toolInfo = this.findToolInfo(toolName);
    const isReadOnly = toolInfo?.annotations?.readOnlyHint === true;

    if (isReadOnly) {
      // Fan out to all locations that have this tool
      return this.fanOutToolCall(toolName, args, locations);
    }

    // Write tool: requires explicit __location
    const targetLocation = args.__location as string | undefined;
    if (!targetLocation) {
      // Build a helpful error with available locations
      const locationNames = locations.map((locId) => {
        const nameRow = this.ctx.storage.sql.exec(
          `SELECT location_name FROM locations WHERE location_id = ?`,
          locId,
        ).toArray();
        return { id: locId, name: (nameRow[0]?.location_name as string) || locId };
      });
      return {
        success: false,
        error: `Multi-location write operation requires __location argument. Available locations: ${JSON.stringify(locationNames)}`,
      };
    }

    // Remove __location from args before sending
    const { __location, ...cleanArgs } = args;
    return this.sendToolCall(targetLocation, toolName, cleanArgs);
  }

  private async sendToolCall(
    locationId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const ws = this.findWebSocketForLocation(locationId);
    if (!ws) {
      return { success: false, error: `Location ${locationId} is not connected` };
    }

    const callId = crypto.randomUUID();

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`Tool call timed out after ${TOOL_CALL_TIMEOUT_MS}ms`));
      }, TOOL_CALL_TIMEOUT_MS);

      this.pending.set(callId, { resolve, reject, timeout });

      const request: ToolCallRequest = {
        type: "tool_call",
        call_id: callId,
        tool_name: toolName,
        arguments: args,
        timeout_ms: TOOL_CALL_TIMEOUT_MS,
      };

      this.sendWs(ws, request);
    });

    // If the result is already a structured response, return it
    if (result && typeof result === "object" && "success" in (result as Record<string, unknown>)) {
      return result as Record<string, unknown>;
    }

    return { success: true, data: result };
  }

  private async fanOutToolCall(
    toolName: string,
    args: Record<string, unknown>,
    locationIds: string[],
  ): Promise<AggregatedResponse> {
    // Remove __location from args if present (not needed for fan-out)
    const { __location, ...cleanArgs } = args;

    const promises = locationIds.map(async (locationId): Promise<FanOutResult> => {
      const ws = this.findWebSocketForLocation(locationId);
      const locationName = this.getLocationName(locationId);

      if (!ws) {
        return { location_id: locationId, location_name: locationName, error: "Not connected" };
      }

      const callId = `${crypto.randomUUID()}-${locationId}`;

      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pending.delete(callId);
            reject(new Error(`Timed out after ${TOOL_CALL_TIMEOUT_MS}ms`));
          }, TOOL_CALL_TIMEOUT_MS);

          this.pending.set(callId, { resolve, reject, timeout });

          const request: ToolCallRequest = {
            type: "tool_call",
            call_id: callId,
            tool_name: toolName,
            arguments: cleanArgs,
            timeout_ms: TOOL_CALL_TIMEOUT_MS,
          };

          this.sendWs(ws, request);
        });

        return { location_id: locationId, location_name: locationName, data: result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return { location_id: locationId, location_name: locationName, error: msg };
      }
    });

    const results = await Promise.allSettled(promises);
    const fanOutResults: FanOutResult[] = results.map((r) => {
      if (r.status === "fulfilled") return r.value;
      return {
        location_id: "unknown",
        location_name: "unknown",
        error: r.reason instanceof Error ? r.reason.message : "Unknown error",
      };
    });

    const responded = fanOutResults.filter((r) => !r.error).length;

    return {
      success: responded > 0,
      results: fanOutResults,
      partial: responded > 0 && responded < locationIds.length,
      locations_total: locationIds.length,
      locations_responded: responded,
    };
  }

  // -------------------------------------------------------------------------
  // Helper methods
  // -------------------------------------------------------------------------

  /** Get deduplicated tools across all locations (for eager mode) */
  getAggregatedTools(): ToolInfo[] {
    const seen = new Set<string>();
    const tools: ToolInfo[] = [];

    for (const locationToolList of this.locationTools.values()) {
      for (const tool of locationToolList) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          tools.push(tool);
        }
      }
    }

    return tools;
  }

  private findToolInfo(toolName: string): ToolInfo | undefined {
    for (const tools of this.locationTools.values()) {
      const found = tools.find((t) => t.name === toolName);
      if (found) return found;
    }
    return undefined;
  }

  private findWebSocketForLocation(locationId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment() as { locationId?: string } | null;
        if (attachment?.locationId === locationId) {
          return ws;
        }
      } catch {
        // skip
      }
    }
    return null;
  }

  private getLocationName(locationId: string): string {
    const rows = this.ctx.storage.sql.exec(
      `SELECT location_name FROM locations WHERE location_id = ?`,
      locationId,
    ).toArray();
    return (rows[0]?.location_name as string) || locationId;
  }

  private sendWs(
    ws: WebSocket,
    msg: RegisteredMessage | ToolCallRequest | HeartbeatAckMessage | ErrorMessage,
  ): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // WebSocket may already be closed
    }
  }
}
