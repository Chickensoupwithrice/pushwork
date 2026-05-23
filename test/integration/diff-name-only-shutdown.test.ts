import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as tmp from "tmp";

const execFilePromise = promisify(execFile);
const PUSHWORK_CLI = path.join(__dirname, "../../dist/cli.js");

async function pushwork(
  args: string[],
  cwd: string,
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFilePromise("node", [PUSHWORK_CLI, ...args], {
      cwd,
      timeout,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        PUSHWORK_SYNC_TIMEOUT_MS: process.env.PUSHWORK_SYNC_TIMEOUT_MS ?? "5000",
        PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS:
          process.env.PUSHWORK_BIDIRECTIONAL_SYNC_TIMEOUT_MS ?? "2000",
        PUSHWORK_SYNC_GRACE_MS: process.env.PUSHWORK_SYNC_GRACE_MS ?? "0",
      },
    });
  } catch (error: any) {
    throw new Error(
      `pushwork ${args.join(" ")} failed: ${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`,
    );
  }
}

async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

describe("diff --name-only", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmpObj = tmp.dirSync({ unsafeCleanup: true });
    tmpDir = tmpObj.name;
    cleanup = tmpObj.removeCallback;
  });

  afterEach(() => {
    cleanup();
  });

  it("returns remote-only paths without hanging the CLI", async () => {
    const repoA = path.join(tmpDir, "repo-a");
    const repoB = path.join(tmpDir, "repo-b");
    const repoObserver = path.join(tmpDir, "repo-observer");
    await fs.mkdir(repoA);
    await fs.mkdir(repoB);
    await fs.mkdir(repoObserver);

    await fs.writeFile(path.join(repoA, "hello.md"), "hello\n");
    await pushwork(["init", "."], repoA);

    const { stdout: rootUrl } = await pushwork(["url"], repoA);
    await pushwork(["clone", rootUrl.trim(), repoB], tmpDir);

    await fs.mkdir(path.join(repoA, "alpha"));
    await fs.writeFile(path.join(repoA, "alpha", "second.md"), "second file\n");
    await pushwork(["sync", "--gentle"], repoA);

    await pushwork(["clone", rootUrl.trim(), repoObserver], tmpDir);
    expect(await readFile(path.join(repoObserver, "alpha", "second.md"))).toBe(
      "second file\n",
    );

    const diffOutput = (await pushwork(["diff", "--name-only"], repoB, 4_000)).stdout;
    expect(diffOutput).toContain("alpha/second.md");
  }, 60_000);
});
