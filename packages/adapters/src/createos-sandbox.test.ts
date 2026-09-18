import type { ComputerRef, PortableFile } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { CreateOSSandboxProvider } from "./createos-sandbox.js";

const context = {
  operationId: "test",
  traceId: "trace",
  spaceId: "workspace",
  userId: "user",
  botId: "bot-a",
  signal: new AbortController().signal,
};

const WORKSPACE_LISTING = JSON.stringify([
  { name: "notes.txt", kind: "file", size: 5, executable: false },
]);

interface ExecCall {
  path: string;
  command: string;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: "success", data }), {
    headers: { "content-type": "application/json" },
  });
}

/** Route-driven CreateOS control-plane double. Exec replies are keyed off the shell command. */
function createosFixture(options: { statuses?: string[] } = {}) {
  const statuses = [...(options.statuses ?? ["running"])];
  const calls: string[] = [];
  const execs: ExecCall[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    calls.push(route);

    if (route === "POST /v1/sandboxes") {
      return jsonResponse({ id: "sbx-1", status: statuses[0] ?? "running" });
    }
    if (method === "GET" && /^\/v1\/sandboxes\/[^/]+$/.test(url.pathname)) {
      return jsonResponse({ id: "sbx-1", status: statuses.shift() ?? "running" });
    }
    if (method === "POST" && url.pathname.endsWith("/exec")) {
      const body = JSON.parse(String(init?.body)) as { args: string[] };
      const command = body.args[3] ?? "";
      execs.push({ path: url.pathname, command });
      if (command.includes("os.listdir")) {
        return jsonResponse({ result: { stdout: WORKSPACE_LISTING, exit_code: 0 } });
      }
      // Both browser probes talk to a devtools port that the double does not run.
      if (command.includes("127.0.0.1:9222")) {
        return jsonResponse({ result: { stdout: "", exit_code: 1 } });
      }
      return jsonResponse({ result: { stdout: "hello\n", exit_code: 0 } });
    }
    if (method === "GET" && url.pathname.endsWith("/files")) {
      return new Response(new TextEncoder().encode("notes"));
    }
    return jsonResponse({});
  }) as typeof fetch;

  return { calls, execs, fetchImpl };
}

function provider(fixture: ReturnType<typeof createosFixture>) {
  return new CreateOSSandboxProvider({ apiKey: "test-key", fetch: fixture.fetchImpl });
}

const computer: ComputerRef = {
  id: "sbx-1",
  botId: "bot-a",
  kind: "createos",
  providerRef: "sbx-1",
  fresh: true,
};

describe("CreateOSSandboxProvider", () => {
  it("creates a sandbox and waits until it runs", async () => {
    const fixture = createosFixture({ statuses: ["provisioning", "running"] });
    const ref = await provider(fixture).provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(ref).toMatchObject({ id: "sbx-1", providerRef: "sbx-1", kind: "createos", fresh: true });
    expect(fixture.calls.filter((call) => call === "GET /v1/sandboxes/sbx-1").length).toBe(2);
  });

  it("resumes a paused sandbox and waits for it", async () => {
    const fixture = createosFixture({ statuses: ["paused", "running"] });
    const ref = await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(ref.fresh).toBe(false);
    expect(fixture.calls).toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls).not.toContain("POST /v1/sandboxes");
  });

  it("lets a pausing sandbox settle before it resumes", async () => {
    const fixture = createosFixture({ statuses: ["pausing", "pausing", "paused", "running"] });
    const ref = await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(ref.fresh).toBe(false);
    expect(fixture.calls).toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls).not.toContain("POST /v1/sandboxes");
  });

  it("waits for an existing sandbox that is neither running nor paused", async () => {
    const fixture = createosFixture({ statuses: ["starting", "running"] });
    await provider(fixture).provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "sbx-1", providerKind: "createos" },
      context,
    );

    expect(fixture.calls).not.toContain("POST /v1/sandboxes/sbx-1/resume");
    expect(fixture.calls.filter((call) => call === "GET /v1/sandboxes/sbx-1").length).toBe(2);
  });

  it("runs commands inside the workspace with the requested environment", async () => {
    const fixture = createosFixture();
    const events = [];
    for await (const event of provider(fixture).execute(
      computer,
      { argv: ["echo", "hello"], cwd: "notes", env: { TEST_VALUE: "works" } },
      context,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    const command = fixture.execs.at(-1)?.command ?? "";
    expect(command).toContain("cd '/home/desktop/rakazo-home/notes'");
    expect(command).toContain("TEST_VALUE='works'");
  });

  it("reports a timed-out command as exit code 124", async () => {
    const fetchImpl = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const events = [];
    for await (const event of new CreateOSSandboxProvider({
      apiKey: "test-key",
      fetch: fetchImpl,
    }).execute(computer, { argv: ["sleep", "600"] }, context)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({ type: "exit", code: 124 });
    expect(events[0]).toMatchObject({ type: "stderr" });
  });

  it("exports the workspace after a graphical action alone", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(computer, { actions: [{ kind: "wait", ms: 0 }], observe: false }, context);

    const files: PortableFile[] = [];
    for await (const file of target.exportWorkspace(computer, context)) files.push(file);

    expect(files.map((file) => file.path)).toEqual(["notes.txt"]);
  });

  it("forgets per-sandbox state on stop and destroy", async () => {
    const fixture = createosFixture();
    const target = provider(fixture);
    await target.act(computer, { actions: [{ kind: "wait", ms: 0 }], observe: false }, context);
    await target.stop(computer, context);

    const afterStop: PortableFile[] = [];
    for await (const file of target.exportWorkspace(computer, context)) afterStop.push(file);
    expect(afterStop).toEqual([]);

    await target.destroy(computer, context);
    expect(fixture.calls).toContain("DELETE /v1/sandboxes/sbx-1");
  });
});
