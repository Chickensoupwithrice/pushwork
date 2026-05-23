import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";
import {
  appendTextFile,
  cloneWorkspace,
  diffWorkspace,
  initializeWorkspace,
  syncWorkspace,
  startLocalRelay,
  type LocalRelay,
  type WorkspaceHandle,
} from "../helpers/deterministic-harness";

async function main(): Promise<void> {
  const tmpObj = tmp.dirSync({ unsafeCleanup: true });
  const cleanup = tmpObj.removeCallback;

  let relay: LocalRelay | undefined;
  let workspaceA: WorkspaceHandle | undefined;
  let workspaceB: WorkspaceHandle | undefined;

  try {
    const repoAPath = path.join(tmpObj.name, "repo-a");
    const repoBPath = path.join(tmpObj.name, "repo-b");
    await fs.mkdir(repoAPath, { recursive: true });
    await fs.mkdir(repoBPath, { recursive: true });
    await fs.writeFile(path.join(repoAPath, "inbox.md"), "# Inbox\n\nbase\n", "utf8");

    relay = await startLocalRelay(tmpObj.name);
    const initialized = await initializeWorkspace(repoAPath, relay);
    workspaceA = initialized;
    workspaceB = await cloneWorkspace(initialized.rootUrl, repoBPath, relay);

    await appendTextFile(workspaceA, "inbox.md", "PRIMARY\n");
    await appendTextFile(workspaceB, "inbox.md", "CLONE\n");

    await syncWorkspace(workspaceA);
    await syncWorkspace(workspaceB);

    const diffOutput = await diffWorkspace(workspaceA);
    if (diffOutput.includes("No changes detected")) {
      throw new Error(
        "Deterministic harness caught stale remote visibility: existing workspace stayed blind to remote advancement."
      );
    }

    console.log(diffOutput.trim());
  } finally {
    if (relay) {
      await relay.stop();
    }
    cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
