// src/index.ts
export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("OK");
  },
};

// Placeholder for Durable Object export
export class RelayObject {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    return new Response("OK");
  }
}
