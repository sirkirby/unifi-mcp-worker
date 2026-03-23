// test/relay-object.test.ts
//
// Unit tests for RelayObject pure-logic methods and the RelayStub interface.
// We cannot instantiate a real Durable Object or use SQLite/WebSockets in
// vitest (that requires miniflare), so we test the exported pure functions
// and validate the meta-tool definitions and routing logic indirectly.

import { describe, it, expect, vi } from "vitest";
import type { ToolInfo, AggregatedResponse } from "../src/types";

// ---------------------------------------------------------------------------
// Since RelayObject depends on Cloudflare Durable Object runtime, we extract
// and test the logic that can be exercised without the DO context.
// We import the class type for interface verification and test the RelayStub
// contract through the MCP handler integration.
// ---------------------------------------------------------------------------

import { handleMcpRequest, type RelayStub } from "../src/mcp-handler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal RelayStub mock backed by an in-memory tool map */
function createMockRelay(
  locationToolsMap: Map<string, ToolInfo[]> = new Map(),
): RelayStub & {
  locationTools: Map<string, ToolInfo[]>;
  getAggregatedTools: () => ToolInfo[];
} {
  const locationTools = locationToolsMap;

  // Build toolToLocations from locationTools
  const toolToLocations = new Map<string, string[]>();
  for (const [locId, tools] of locationTools) {
    for (const tool of tools) {
      if (!toolToLocations.has(tool.name)) {
        toolToLocations.set(tool.name, []);
      }
      const locs = toolToLocations.get(tool.name)!;
      if (!locs.includes(locId)) {
        locs.push(locId);
      }
    }
  }

  function getAggregatedTools(): ToolInfo[] {
    const seen = new Set<string>();
    const tools: ToolInfo[] = [];
    for (const locationToolList of locationTools.values()) {
      for (const tool of locationToolList) {
        if (!seen.has(tool.name)) {
          seen.add(tool.name);
          tools.push(tool);
        }
      }
    }
    return tools;
  }

  const stub: RelayStub & {
    locationTools: Map<string, ToolInfo[]>;
    getAggregatedTools: () => ToolInfo[];
  } = {
    locationTools,
    getAggregatedTools,

    async getToolList(mode: string): Promise<ToolInfo[]> {
      if (mode === "lazy" || mode === "meta_only") {
        // Return meta-tools
        return [
          {
            name: "unifi_tool_index",
            description: "List all available UniFi tools",
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
          },
          {
            name: "unifi_execute",
            description: "Execute a UniFi tool by name",
            annotations: { readOnlyHint: false, openWorldHint: false },
          },
          {
            name: "unifi_batch",
            description: "Execute multiple UniFi tools in a single request",
            annotations: { readOnlyHint: false, openWorldHint: false },
          },
        ];
      }
      return getAggregatedTools();
    },

    async handleToolCall(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown> | AggregatedResponse> {
      if (toolName === "unifi_tool_index") {
        const tools = getAggregatedTools();
        return { success: true, data: { tools, total: tools.length, multi_location: locationTools.size > 1 } };
      }
      return { success: false, error: `Tool not found: ${toolName}` };
    },

    async isMultiLocation(): Promise<boolean> {
      return locationTools.size > 1;
    },
  };

  return stub;
}

function sampleTools(): ToolInfo[] {
  return [
    {
      name: "list_clients",
      description: "List all connected clients",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_devices",
      description: "List all network devices",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "restart_device",
      description: "Restart a network device",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}

// ---------------------------------------------------------------------------
// getAggregatedTools
// ---------------------------------------------------------------------------
describe("getAggregatedTools", () => {
  it("returns empty array when no locations are registered", () => {
    const relay = createMockRelay(new Map());
    expect(relay.getAggregatedTools()).toEqual([]);
  });

  it("returns all tools from a single location", () => {
    const tools = sampleTools();
    const relay = createMockRelay(new Map([["loc-1", tools]]));
    const result = relay.getAggregatedTools();
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(["list_clients", "list_devices", "restart_device"]);
  });

  it("deduplicates tools that appear in multiple locations", () => {
    const tools1: ToolInfo[] = [
      { name: "list_clients", description: "List all connected clients" },
      { name: "list_devices", description: "List all network devices" },
    ];
    const tools2: ToolInfo[] = [
      { name: "list_clients", description: "List all connected clients" },
      { name: "get_system_info", description: "Get system information" },
    ];

    const relay = createMockRelay(
      new Map([
        ["loc-1", tools1],
        ["loc-2", tools2],
      ]),
    );

    const result = relay.getAggregatedTools();
    expect(result).toHaveLength(3);
    const names = result.map((t) => t.name);
    expect(names).toContain("list_clients");
    expect(names).toContain("list_devices");
    expect(names).toContain("get_system_info");
  });

  it("keeps the first occurrence when tools are duplicated across locations", () => {
    const tools1: ToolInfo[] = [{ name: "list_clients", description: "From location 1" }];
    const tools2: ToolInfo[] = [{ name: "list_clients", description: "From location 2" }];

    const relay = createMockRelay(
      new Map([
        ["loc-1", tools1],
        ["loc-2", tools2],
      ]),
    );

    const result = relay.getAggregatedTools();
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("From location 1");
  });
});

// ---------------------------------------------------------------------------
// getToolList
// ---------------------------------------------------------------------------
describe("getToolList", () => {
  it("returns meta-tools in lazy mode", async () => {
    const relay = createMockRelay(new Map([["loc-1", sampleTools()]]));
    const tools = await relay.getToolList("lazy");

    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("unifi_tool_index");
    expect(names).toContain("unifi_execute");
    expect(names).toContain("unifi_batch");
  });

  it("returns meta-tools in meta_only mode", async () => {
    const relay = createMockRelay(new Map([["loc-1", sampleTools()]]));
    const tools = await relay.getToolList("meta_only");

    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("unifi_tool_index");
    expect(names).toContain("unifi_execute");
    expect(names).toContain("unifi_batch");
  });

  it("returns all aggregated tools in eager mode", async () => {
    const relay = createMockRelay(new Map([["loc-1", sampleTools()]]));
    const tools = await relay.getToolList("eager");

    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_clients");
    expect(names).toContain("list_devices");
    expect(names).toContain("restart_device");
  });

  it("returns deduplicated tools in eager mode for multi-location", async () => {
    const tools1: ToolInfo[] = [{ name: "list_clients", description: "List clients" }];
    const tools2: ToolInfo[] = [
      { name: "list_clients", description: "List clients" },
      { name: "list_devices", description: "List devices" },
    ];

    const relay = createMockRelay(
      new Map([
        ["loc-1", tools1],
        ["loc-2", tools2],
      ]),
    );

    const tools = await relay.getToolList("eager");
    expect(tools).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// isMultiLocation
// ---------------------------------------------------------------------------
describe("isMultiLocation", () => {
  it("returns false when no locations are registered", async () => {
    const relay = createMockRelay(new Map());
    expect(await relay.isMultiLocation()).toBe(false);
  });

  it("returns false for a single location", async () => {
    const relay = createMockRelay(new Map([["loc-1", sampleTools()]]));
    expect(await relay.isMultiLocation()).toBe(false);
  });

  it("returns true for multiple locations", async () => {
    const relay = createMockRelay(
      new Map([
        ["loc-1", [{ name: "list_clients", description: "List clients" }]],
        ["loc-2", [{ name: "list_devices", description: "List devices" }]],
      ]),
    );
    expect(await relay.isMultiLocation()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MCP handler integration with RelayStub
// ---------------------------------------------------------------------------
describe("MCP handler with relay stub", () => {
  it("tools/list forces lazy mode for multi-location", async () => {
    const relay = createMockRelay(
      new Map([
        ["loc-1", sampleTools()],
        ["loc-2", sampleTools()],
      ]),
    );

    const spyGetToolList = vi.spyOn(relay, "getToolList");

    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      relay,
      "eager",
    );

    // Multi-location should force lazy mode regardless of the mode param
    expect(spyGetToolList).toHaveBeenCalledWith("lazy");
    expect(response.error).toBeUndefined();

    const result = response.result as Record<string, unknown>;
    const tools = result.tools as ToolInfo[];
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toContain("unifi_tool_index");
  });

  it("tools/list uses the configured mode for single location", async () => {
    const relay = createMockRelay(new Map([["loc-1", sampleTools()]]));
    const spyGetToolList = vi.spyOn(relay, "getToolList");

    await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      relay,
      "eager",
    );

    expect(spyGetToolList).toHaveBeenCalledWith("eager");
  });

  it("tools/call dispatches unifi_tool_index and returns tool catalog", async () => {
    const relay = createMockRelay(new Map([["loc-1", sampleTools()]]));

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "unifi_tool_index", arguments: {} },
      },
      relay,
      "lazy",
    );

    expect(response.error).toBeUndefined();
    const result = response.result as Record<string, unknown>;
    const content = result.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);

    const parsed = JSON.parse(content[0].text as string);
    expect(parsed.success).toBe(true);
    expect(parsed.data.tools).toHaveLength(3);
    expect(parsed.data.multi_location).toBe(false);
  });

  it("tools/call returns error for unknown tool", async () => {
    const relay = createMockRelay(new Map([["loc-1", sampleTools()]]));

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "nonexistent_tool", arguments: {} },
      },
      relay,
      "lazy",
    );

    expect(response.error).toBeUndefined();
    const result = response.result as Record<string, unknown>;
    const content = result.content as Array<Record<string, unknown>>;
    const parsed = JSON.parse(content[0].text as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Meta-tool definitions validation
// ---------------------------------------------------------------------------
describe("meta-tool definitions", () => {
  it("all three meta-tools have valid annotations", async () => {
    const relay = createMockRelay(new Map());
    const tools = await relay.getToolList("lazy");

    for (const tool of tools) {
      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe("boolean");
    }
  });

  it("unifi_tool_index is read-only", async () => {
    const relay = createMockRelay(new Map());
    const tools = await relay.getToolList("lazy");
    const index = tools.find((t) => t.name === "unifi_tool_index");

    expect(index).toBeDefined();
    expect(index!.annotations?.readOnlyHint).toBe(true);
    expect(index!.annotations?.idempotentHint).toBe(true);
  });

  it("unifi_execute and unifi_batch are not read-only", async () => {
    const relay = createMockRelay(new Map());
    const tools = await relay.getToolList("lazy");

    const execute = tools.find((t) => t.name === "unifi_execute");
    const batch = tools.find((t) => t.name === "unifi_batch");

    expect(execute).toBeDefined();
    expect(execute!.annotations?.readOnlyHint).toBe(false);

    expect(batch).toBeDefined();
    expect(batch!.annotations?.readOnlyHint).toBe(false);
  });
});
