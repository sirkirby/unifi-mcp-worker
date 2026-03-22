// src/index.ts
export { RelayObject } from "./relay-object";

export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("OK");
  },
};
