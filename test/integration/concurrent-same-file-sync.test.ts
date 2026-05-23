import * as fs from "fs/promises";
import * as path from "path";

import {
  cloneWorkspace,
  initializeWorkspace,
  pushwork,
  startLocalRelay,
  type LocalRelay,
} from "../helpers/deterministic-harness";

describe("Existing-workspace remote visibility", () => {
  let tmpDir: string;
  let testHome: string;
  let cleanupTmp: (() => void) | undefined;
  let relay: LocalRelay | undefined;

  beforeEach(async () => {
    const tmp = await import("tmp");
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanupTmp = tmpObj.removeCallback;

    testHome = path.join(tmpDir, "home");
    await fs.mkdir(testHome, { recursive: true });
    process.env.PUSHWORK_TEST_HOME = testHome;

    relay = await startLocalRelay(tmpDir);
  });

  afterEach(async () => {
    if (relay) {
      await relay.stop();
      relay = undefined;
    }
    delete process.env.PUSHWORK_TEST_HOME;
    cleanupTmp?.();
    cleanupTmp = undefined;
  });

  /**
   * Regression: after another peer advances the remote head of a
   * tracked file, `pushwork diff` from an existing workspace must
   * notice and report the change. Previously the existing-workspace
   * diff path ran with networking disabled and `previewChanges` did
   * not refresh remote state, so it would print "No changes detected"
   * indefinitely.
   *
   * The scenario only requires *some* remote advancement to land on a
   * tracked file. It does not depend on whether two concurrent
   * peer-side edits get merged end to end — that is a separate
   * conflict-resolution concern.
   */
  it("notices when another peer advances a tracked file remotely", async () => {
    const repoAPath = path.join(tmpDir, "repo-a");
    const repoBPath = path.join(tmpDir, "repo-b");
    await fs.mkdir(repoAPath, { recursive: true });
    await fs.mkdir(repoBPath, { recursive: true });

    await fs.writeFile(path.join(repoAPath, "inbox.md"), "baseline\n");

    const workspaceA = await initializeWorkspace(repoAPath, relay!);
    const workspaceB = await cloneWorkspace(
      workspaceA.rootUrl,
      repoBPath,
      relay!,
    );

    // B advances the tracked file on the relay. A is still on
    // baseline locally; nothing happens on its filesystem.
    await fs.writeFile(
      path.join(workspaceB.dir, "inbox.md"),
      "baseline\nCLONE-EDIT\n",
    );
    await pushwork(["sync", "--gentle"], workspaceB.dir);

    // From A's perspective the file content is unchanged locally,
    // but the remote document has new heads. `pushwork diff` must
    // refresh remote state before running change detection.
    const diffOutput = (await pushwork(["diff"], workspaceA.dir)).stdout;
    expect(diffOutput).not.toContain("No changes detected");
  }, 90_000);
});
