import { afterEach, expect, it, vi } from "vitest";
import { api, initContext } from "../src/http.js";
afterEach(() => vi.unstubAllGlobals());
it("lets a stopped request unwind without exiting the terminal process", async () => {
  initContext({ apiUrl: "https://example.test", token: "test-token" });
  const signal = AbortSignal.abort();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("Stopped", "AbortError")));
  await expect(api("/api/conversations/test/chat", { signal })).rejects.toMatchObject({ name: "AbortError" });
});
