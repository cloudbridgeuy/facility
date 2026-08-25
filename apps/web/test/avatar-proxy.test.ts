import { createServer, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../app/api/avatars/[...target]/route";

// A local fake of the GitHub avatar surface: deterministic bytes, no
// network access. The suite never needs live credentials or egress.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type CapturedRequest = { url: string; headers: Headers };
let upstreamRequests: CapturedRequest[] = [];

function startUpstream(listener: RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(listener);
    serversToClose.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function serveAvatar(
  respond: (request: CapturedRequest) => { status: number; body?: Uint8Array; type?: string },
): Promise<void> {
  const origin = await startUpstream((request, response) => {
    request.resume(); // Drain so 'end' fires; we only need headers.
    request.on("end", () => {
      const parsed = new URL(request.url ?? "/", origin);
      const upstreamUrl =
        parsed.pathname
          .replace(/^\/gh/, "https://github.com")
          .replace(/^\/avatars\/u\//, "https://avatars.githubusercontent.com/u/") +
        (parsed.search || "");
      const captured = {
        // The route's fixed upstream hosts are rewritten onto this local
        // fake; strip the rewrite so assertions read the real target.
        url: upstreamUrl,
        headers: new Headers(request.headers as Record<string, string>),
      };
      upstreamRequests.push(captured);
      const outcome = respond(captured);
      response.writeHead(outcome.status, { "content-type": outcome.type ?? "text/plain" });
      response.end(outcome.body ?? null);
    });
  });
  // Point the module's fixed hosts at the local fake for this test only.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const rewritten = String(input instanceof URL ? input : input)
      .replace("https://github.com", `${origin}/gh`)
      .replace("https://avatars.githubusercontent.com", `${origin}/avatars`);
    return originalFetch(new Request(rewritten, init));
  }) as typeof fetch;
  cleanup.push(() => {
    globalThis.fetch = originalFetch;
  });
}

const cleanup: (() => Promise<void> | void)[] = [];
const serversToClose: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  upstreamRequests = [];
  // Unwind in reverse so nested fetch overrides restore correctly.
  for (const undo of cleanup.splice(0).reverse()) await undo();
  await Promise.all(
    serversToClose.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // Undici keeps idle keep-alive sockets open; drop them so close resolves.
          server.closeIdleConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function routeGet(path: string, env: Record<string, string | undefined> = {}): Promise<Response> {
  // The route reads the mode from process.env; swap it per call.
  const previous = process.env.NEXT_PUBLIC_FACILITY_AVATARS;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const segments = path.split("/").filter(Boolean);
  return GET(new Request(`https://app.example/api/avatars/${path}`), {
    params: Promise.resolve({ target: segments }),
  }).finally(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_FACILITY_AVATARS;
    else process.env.NEXT_PUBLIC_FACILITY_AVATARS = previous;
  });
}

describe("the /api/avatars proxy route", () => {
  it("forwards a valid login target as image bytes from this origin", async () => {
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await response.arrayBuffer());
    expect([...body]).toEqual([...PNG_BYTES]);
    expect(upstreamRequests).toHaveLength(1);
    const captured: CapturedRequest = upstreamRequests[0] ?? { url: "", headers: new Headers() };
    expect(captured.url).toBe("https://github.com/octocat.png?size=40");
    // Fresh outbound request: nothing about the deployment or viewer leaks.
    expect(captured.headers?.get("cookie")).toBeNull();
    expect(captured.headers?.get("authorization")).toBeNull();
    expect(captured.headers?.get("referer")).toBeNull();
  });

  it("serves numeric-ID targets from the avatars host", async () => {
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("id/583231");
    expect(response.status).toBe(200);
    expect(upstreamRequests[0]?.url).toContain("https://avatars.githubusercontent.com/u/583231");
  });

  it("rejects any path that is not one of the two exact shapes", async () => {
    for (const hostile of [
      "u/../etc/passwd",
      "u/octocat/extra",
      "id/not-a-number",
      "u/-leading-hyphen",
      "other/octocat",
      "",
    ]) {
      const response = await routeGet(hostile);
      expect(response.status).toBe(404);
    }
    expect(upstreamRequests).toHaveLength(0);
  });

  it("fails closed to 404 when the upstream answer is not an image", async () => {
    await serveAvatar(() => ({ status: 200, type: "text/html", body: new Uint8Array([60]) }));
    expect((await routeGet("u/octocat")).status).toBe(404);

    await serveAvatar(() => ({ status: 404 }));
    expect((await routeGet("u/octocat")).status).toBe(404);
  });

  it("fails closed to 404 when the upstream is unreachable", async () => {
    // No fake started: fetch fails outright.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    cleanup.push(() => {
      globalThis.fetch = originalFetch;
    });
    const response = await routeGet("u/octocat");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).not.toBe("max-age=86400");
  });

  it("serves nothing but 404 when the avatar mode is off", async () => {
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat", { NEXT_PUBLIC_FACILITY_AVATARS: "off" });
    expect(response.status).toBe(404);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("marks successful responses as cacheable but private", async () => {
    await serveAvatar(() => ({ status: 200, body: PNG_BYTES, type: "image/png" }));
    const response = await routeGet("u/octocat");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
