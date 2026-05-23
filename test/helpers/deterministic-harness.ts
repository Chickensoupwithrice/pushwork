import * as fs from "fs/promises";
import * as path from "path";
import * as net from "net";
import { execFile, spawn, type ChildProcessByStdio } from "child_process";
import { promisify } from "util";
import { type Readable } from "stream";
import { type StorageId } from "@automerge/automerge-repo";

const execFilePromise = promisify(execFile);
const PUSHWORK_CLI = path.join(__dirname, "../../dist/cli.js");
const LOCAL_RELAY_SCRIPT = path.join(__dirname, "local-relay-server.ts");
const TSX_BIN = path.join(__dirname, "../../node_modules/.bin/tsx");

type RelayProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface LocalRelay {
  url: string;
  storageId: StorageId;
  stop: () => Promise<void>;
}

export interface WorkspaceHandle {
  dir: string;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a free TCP port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function pushworkEnv(): NodeJS.ProcessEnv {
  const testHome = process.env.PUSHWORK_TEST_HOME;
  return {
    ...process.env,
    FORCE_COLOR: "0",
    PUSHWORK_SYNC_GRACE_MS: process.env.PUSHWORK_SYNC_GRACE_MS ?? "0",
    PUSHWORK_SYNC_TIMEOUT_MS: process.env.PUSHWORK_SYNC_TIMEOUT_MS ?? "5000",
    PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS:
      process.env.PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS ?? "2000",
    ...(testHome
      ? {
          HOME: testHome,
          USERPROFILE: testHome,
          XDG_CONFIG_HOME: path.join(testHome, ".config"),
        }
      : {}),
  };
}

export async function pushwork(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFilePromise(process.execPath, [PUSHWORK_CLI, ...args], {
      cwd,
      env: pushworkEnv(),
    });
  } catch (error: any) {
    throw new Error(
      `pushwork ${args.join(" ")} failed: ${error.message}\nstdout: ${
        error.stdout
      }\nstderr: ${error.stderr}`
    );
  }
}

export async function startLocalRelay(rootDir: string): Promise<LocalRelay> {
  const port = await getFreePort();
  const dataDir = path.join(rootDir, "relay-data");
  await fs.mkdir(dataDir, { recursive: true });

  try {
    await fs.access(TSX_BIN);
  } catch {
    throw new Error(
      `Could not find tsx binary at ${TSX_BIN}. Run \`pnpm install\` so the deterministic harness can launch its local relay.`
    );
  }

  let child: RelayProcess | undefined;
  let storageId: StorageId | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting local relay at ${LOCAL_RELAY_SCRIPT}`));
    }, 15000);

    const stderrBuffer: string[] = [];

    const onStdout = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const match = line.match(/^READY\s+(\S+)$/);
        if (match) {
          storageId = match[1] as StorageId;
          clearTimeout(timeout);
          resolve();
        }
      }
    };

    const onStderr = (chunk: Buffer) => {
      stderrBuffer.push(chunk.toString());
    };

    const spawned = spawn(TSX_BIN, [LOCAL_RELAY_SCRIPT], {
      cwd: rootDir,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;

    spawned.stdout.on("data", onStdout);
    spawned.stderr.on("data", onStderr);
    spawned.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    spawned.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (storageId === undefined) {
        reject(
          new Error(
            `Local relay exited before becoming ready (code=${code}, signal=${signal})\n${stderrBuffer.join("")}`
          )
        );
      }
    });
  });

  await ready;

  return {
    url: `ws://127.0.0.1:${port}`,
    storageId: storageId!,
    stop: async () => {
      if (!child || child.killed) {
        return;
      }

      await new Promise<void>((resolve) => {
        child!.once("exit", () => resolve());
        child!.kill("SIGTERM");
        setTimeout(() => {
          if (!child!.killed) {
            child!.kill("SIGKILL");
          }
          resolve();
        }, 2000);
      });
    },
  };
}

export async function initializeWorkspace(
  dir: string,
  relay: Pick<LocalRelay, "url" | "storageId">
): Promise<WorkspaceHandle & { rootUrl: string }> {
  await fs.mkdir(dir, { recursive: true });
  await pushwork(["init", ".", "--sync-server", relay.url, relay.storageId], dir);
  const { stdout } = await pushwork(["url"], dir);
  return {
    dir,
    rootUrl: stdout.trim(),
  };
}

export async function cloneWorkspace(
  rootUrl: string,
  dir: string,
  relay: Pick<LocalRelay, "url" | "storageId">
): Promise<WorkspaceHandle> {
  await fs.mkdir(dir, { recursive: true });
  await pushwork(
    ["clone", rootUrl, dir, "--sync-server", relay.url, relay.storageId],
    path.dirname(dir)
  );
  return { dir };
}

export async function syncWorkspace(workspace: WorkspaceHandle): Promise<void> {
  await pushwork(["sync", "--gentle"], workspace.dir);
}

export async function diffWorkspace(workspace: WorkspaceHandle): Promise<string> {
  const result = await pushwork(["diff"], workspace.dir);
  return result.stdout;
}

export async function hashWorkspace(dir: string): Promise<string> {
  const files = await listWorkspaceFiles(dir);
  const crypto = await import("crypto");
  const hash = crypto.createHash("sha256");

  for (const file of files) {
    hash.update(file);
    hash.update(await fs.readFile(path.join(dir, file)));
  }

  return hash.digest("hex");
}

export async function listWorkspaceFiles(
  dir: string,
  baseDir: string = dir
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".pushwork") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listWorkspaceFiles(fullPath, baseDir)));
      continue;
    }

    if (entry.isFile()) {
      files.push(path.relative(baseDir, fullPath).replace(/\\/g, "/"));
    }
  }

  files.sort();
  return files;
}

export async function syncUntilConverged(
  workspaces: WorkspaceHandle[],
  options: { maxRounds?: number } = {}
): Promise<{ rounds: number; hashes: string[] }> {
  const maxRounds = options.maxRounds ?? 6;

  for (let round = 1; round <= maxRounds; round++) {
    for (const workspace of workspaces) {
      await syncWorkspace(workspace);
    }

    const hashes = await Promise.all(workspaces.map((workspace) => hashWorkspace(workspace.dir)));
    if (hashes.every((hash) => hash === hashes[0])) {
      return { rounds: round, hashes };
    }
  }

  return {
    rounds: maxRounds,
    hashes: await Promise.all(workspaces.map((workspace) => hashWorkspace(workspace.dir))),
  };
}

export async function writeTextFile(
  workspace: WorkspaceHandle,
  relativePath: string,
  content: string
): Promise<void> {
  const fullPath = path.join(workspace.dir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

export async function appendTextFile(
  workspace: WorkspaceHandle,
  relativePath: string,
  content: string
): Promise<void> {
  const fullPath = path.join(workspace.dir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.appendFile(fullPath, content, "utf8");
}

export async function deletePath(
  workspace: WorkspaceHandle,
  relativePath: string
): Promise<void> {
  await fs.rm(path.join(workspace.dir, relativePath), { recursive: true, force: true });
}

export async function renamePath(
  workspace: WorkspaceHandle,
  fromPath: string,
  toPath: string
): Promise<void> {
  const fullFromPath = path.join(workspace.dir, fromPath);
  try {
    await fs.access(fullFromPath);
  } catch {
    return;
  }

  const fullToPath = path.join(workspace.dir, toPath);
  await fs.mkdir(path.dirname(fullToPath), { recursive: true });
  await fs.rm(fullToPath, { recursive: true, force: true });
  await fs.rename(fullFromPath, fullToPath);
}
