import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import * as fc from "fast-check";
import {
  appendTextFile,
  cloneWorkspace,
  deletePath,
  hashWorkspace,
  initializeWorkspace,
  renamePath,
  startLocalRelay,
  syncUntilConverged,
  syncWorkspace,
  type WorkspaceHandle,
  writeTextFile,
} from "../helpers/deterministic-harness";

type RepoId = "A" | "B";

type Operation =
  | { kind: "write"; relativePath: string; text: string }
  | { kind: "append"; relativePath: string; text: string }
  | { kind: "delete"; relativePath: string }
  | { kind: "rename"; fromPath: string; toPath: string };

interface ReplayTrace {
  repoAOperations: Operation[];
  repoBOperations: Operation[];
}

const FILE_PATHS = ["notes.md", "todo.txt", "nested/ideas.md"] as const;
const RENAME_PAIRS = [
  { fromPath: "notes.md", toPath: "nested/notes.md" },
  { fromPath: "nested/ideas.md", toPath: "ideas.md" },
  { fromPath: "todo.txt", toPath: "nested/todo.txt" },
] as const;

const textArbitrary = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), {
    minLength: 3,
    maxLength: 12,
  })
  .map((chars) => chars.join(""));

const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant<"write">("write"),
    relativePath: fc.constantFrom(...FILE_PATHS),
    text: textArbitrary,
  }),
  fc.record({
    kind: fc.constant<"append">("append"),
    relativePath: fc.constantFrom(...FILE_PATHS),
    text: textArbitrary,
  }),
  fc.record({
    kind: fc.constant<"delete">("delete"),
    relativePath: fc.constantFrom(...FILE_PATHS),
  }),
  fc.constantFrom(...RENAME_PAIRS).map((pair) => ({ kind: "rename" as const, ...pair }))
);

function fcRunOptions(): fc.Parameters<[Operation[], Operation[]]> {
  const options: fc.Parameters<[Operation[], Operation[]]> = {
    numRuns: Number(process.env.PUSHWORK_FC_NUM_RUNS ?? 1),
  };

  const seed = process.env.PUSHWORK_FC_SEED;
  if (seed !== undefined) {
    options.seed = Number(seed);
  }

  const pathOverride = process.env.PUSHWORK_FC_PATH;
  if (pathOverride) {
    options.path = pathOverride;
  }

  return options;
}

function getReplayTrace(): ReplayTrace | undefined {
  const raw = process.env.PUSHWORK_FC_REPLAY;
  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw) as ReplayTrace;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

async function applyOperation(
  repo: RepoId,
  operation: Operation,
  workspaces: Record<RepoId, WorkspaceHandle>
): Promise<Record<RepoId, WorkspaceHandle>> {
  const workspace = workspaces[repo];

  switch (operation.kind) {
    case "write":
      await writeTextFile(workspace, operation.relativePath, `${repo}:${operation.text}\n`);
      return workspaces;
    case "append":
      await appendTextFile(workspace, operation.relativePath, `${repo}:${operation.text}\n`);
      return workspaces;
    case "delete":
      await deletePath(workspace, operation.relativePath);
      return workspaces;
    case "rename":
      await renamePath(workspace, operation.fromPath, operation.toPath);
      return workspaces;
  }
}

async function runCase(
  tmpDir: string,
  relay: Awaited<ReturnType<typeof startLocalRelay>>,
  repoAOperations: Operation[],
  repoBOperations: Operation[]
): Promise<void> {
  const caseDir = await fs.mkdtemp(path.join(tmpDir, "case-"));
  const repoAPath = path.join(caseDir, "repo-a");
  const repoBPath = path.join(caseDir, "repo-b");
  await fs.mkdir(repoAPath, { recursive: true });
  await fs.mkdir(repoBPath, { recursive: true });
  await fs.writeFile(
    path.join(repoAPath, "notes.md"),
    "# baseline\n\nshared document\n",
    "utf8"
  );

  const initialized = await initializeWorkspace(repoAPath, relay);
  let current: Record<RepoId, WorkspaceHandle> = {
    A: initialized,
    B: await cloneWorkspace(initialized.rootUrl, repoBPath, relay),
  };

  const initialConvergence = await syncUntilConverged([current.A, current.B], {
    maxRounds: 3,
  });
  if (initialConvergence.hashes[0] !== initialConvergence.hashes[1]) {
    throw new Error(`Initial clone did not converge before fuzz operations (caseDir=${caseDir})`);
  }

  for (const operation of repoAOperations) {
    current = await applyOperation("A", operation, current);
  }
  for (const operation of repoBOperations) {
    current = await applyOperation("B", operation, current);
  }

  await syncWorkspace(current.A);
  await syncWorkspace(current.B);

  const convergence = await syncUntilConverged([current.A, current.B], {
    maxRounds: 4,
  });
  if (convergence.hashes[0] !== convergence.hashes[1]) {
    throw new Error(
      `Failed to converge: hashA=${convergence.hashes[0].slice(0, 8)} hashB=${convergence.hashes[1].slice(0, 8)} caseDir=${caseDir}`
    );
  }

  const hashA = await hashWorkspace(current.A.dir);
  const hashB = await hashWorkspace(current.B.dir);
  if (hashA !== hashB) {
    throw new Error(
      `Final hashes differ: hashA=${hashA.slice(0, 8)} hashB=${hashB.slice(0, 8)} caseDir=${caseDir}`
    );
  }

  if (process.env.PUSHWORK_KEEP_PASSED_HARNESS !== "1") {
    await fs.rm(caseDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const tmpObj = tmp.dirSync({ unsafeCleanup: true });
  const tmpDir = tmpObj.name;
  const cleanup = tmpObj.removeCallback;
  const testHome = path.join(tmpDir, "test-home");
  await fs.mkdir(testHome, { recursive: true });
  process.env.PUSHWORK_TEST_HOME = testHome;
  const relay = await startLocalRelay(tmpDir);
  let lastTrace: ReplayTrace | undefined;
  let shouldCleanup = true;

  try {
    const replayTrace = getReplayTrace();
    if (replayTrace) {
      lastTrace = replayTrace;
      await withTimeout(
        runCase(tmpDir, relay, replayTrace.repoAOperations, replayTrace.repoBOperations),
        Number(process.env.PUSHWORK_FC_CASE_TIMEOUT_MS ?? 30000),
        `replay case A=${JSON.stringify(replayTrace.repoAOperations)} B=${JSON.stringify(replayTrace.repoBOperations)}`
      );
    } else {
      await fc.assert(
        fc.asyncProperty(
          fc.array(operationArbitrary, { minLength: 1, maxLength: 5 }),
          fc.array(operationArbitrary, { minLength: 1, maxLength: 5 }),
          async (repoAOperations, repoBOperations) => {
            lastTrace = { repoAOperations, repoBOperations };
            await withTimeout(
              runCase(tmpDir, relay, repoAOperations, repoBOperations),
              Number(process.env.PUSHWORK_FC_CASE_TIMEOUT_MS ?? 30000),
              `seeded case A=${JSON.stringify(repoAOperations)} B=${JSON.stringify(repoBOperations)}`
            );
          }
        ),
        fcRunOptions()
      );
    }

    const seed = process.env.PUSHWORK_FC_SEED ?? "default";
    console.log(`Deterministic sync harness completed successfully (seed=${seed})`);
  } catch (error) {
    shouldCleanup = process.env.PUSHWORK_KEEP_FAILED_HARNESS !== "1";
    if (lastTrace) {
      const replay = JSON.stringify(lastTrace);
      console.error(`Replay trace: ${replay}`);
      console.error(
        `Replay command: PUSHWORK_FC_REPLAY='${replay.replace(/'/g, "'\\''")}' pnpm run test:deterministic-harness`
      );
    }
    throw error;
  } finally {
    await relay.stop();
    if (shouldCleanup) {
      cleanup();
    } else {
      console.error(`Preserved harness tempdir: ${tmpDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
