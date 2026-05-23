/**
 * Standalone WebSocket relay server used by the deterministic harness.
 *
 * Spawned as a child process. Reads PORT and DATA_DIR from the
 * environment, brings up an Automerge sync relay, and writes a single
 * `READY <storageId>` line to stdout once it is accepting connections.
 *
 * The relay is intentionally tiny — just enough to exercise the same
 * code paths Pushwork uses against the public sync server, without
 * pinning the harness to any external machine path or unpublished
 * package version.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { WebSocketServer } from "ws";

// Pushwork itself loads `@automerge/automerge-repo` via a true ESM import
// because the installed package's /slim entry needs the Subduction Wasm
// initialized before `new Repo()`. The same constraint applies here: we
// have to use a real dynamic `import()` rather than tsc's
// `commonjs`-flavored shim. The `new Function` wrapper bypasses tsc's
// rewriting so Node evaluates the call as native ESM.
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<any>;

async function main(): Promise<void> {
  const port = Number(process.env.PORT);
  const dataDir = process.env.DATA_DIR;

  if (!Number.isFinite(port)) {
    throw new Error("PORT env var is required");
  }
  if (!dataDir) {
    throw new Error("DATA_DIR env var is required");
  }
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Pre-allocate the storage-adapter-id before constructing Repo. The
  // upstream StorageSubsystem.id() implementation has a benign race: when
  // the id file does not exist yet, two concurrent callers each generate
  // a fresh UUID. The Repo's internal `peerMetadata` resolves one UUID
  // while our `await repo.storageId()` call resolves a different one, so
  // the storageId we announce on stdout ends up disagreeing with the id
  // advertised in `peer-candidate` metadata. Writing the id ourselves
  // first makes the resolution deterministic.
  const storageIdDir = path.join(dataDir, "st");
  const storageIdFile = path.join(storageIdDir, "orage-adapter-id");
  if (!fs.existsSync(storageIdFile)) {
    fs.mkdirSync(storageIdDir, { recursive: true });
    fs.writeFileSync(storageIdFile, crypto.randomUUID());
  }

  const repoMod = await dynamicImport("@automerge/automerge-repo");
  if (typeof repoMod.initSubduction === "function") {
    await repoMod.initSubduction();
  }
  const { Repo } = repoMod;

  const wsAdapterMod = await dynamicImport(
    "@automerge/automerge-repo-network-websocket",
  );
  const { NodeWSServerAdapter } = wsAdapterMod;

  const storageMod = await dynamicImport(
    "@automerge/automerge-repo-storage-nodefs",
  );
  const { NodeFSStorageAdapter } = storageMod;

  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("pushwork test relay");
  });

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  const repo = new Repo({
    network: [new NodeWSServerAdapter(wss, 60000)],
    storage: new NodeFSStorageAdapter(dataDir),
    peerId: `pushwork-test-relay-${process.pid}`,
    // Server policy: only share what peers already know about.
    sharePolicy: async () => false,
  });

  const storageId = await repo.storageId();

  // Drain pending microtasks so the network adapter's `connect()` has
  // attached its connection handler before we start accepting sockets.
  // Without this, the very first client `join` message can race the
  // adapter setup and be dropped, leaving the client stuck waiting for
  // a `peer` reply that never arrives.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  process.stdout.write(`READY ${storageId}\n`);

  const shutdown = async () => {
    wss.close();
    server.close();
    if (typeof repo.shutdown === "function") {
      await repo.shutdown().catch(() => undefined);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

main().catch((error) => {
  process.stderr.write(
    `local-relay-server failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
