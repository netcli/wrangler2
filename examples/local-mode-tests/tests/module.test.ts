import { spawn } from "child_process";
import { fetch } from "undici";
import type { ChildProcess } from "child_process";
import type { Response } from "undici";

const waitUntilReady = async (url: string): Promise<Response> => {
  let response: Response | undefined = undefined;

  while (response === undefined) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    try {
      response = await fetch(url);
    } catch {}
  }

  return response as Response;
};
const isWindows = process.platform === "win32";

let wranglerProcess: ChildProcess;

beforeAll(async () => {
  // These tests break in CI for windows, so we're disabling them for now
  if (isWindows) return;

  wranglerProcess = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "src/module.ts",
      "--local",
      "--config",
      "src/wrangler.module.toml",
      "--port",
      "9001",
    ],
    {
      shell: isWindows,
      stdio: "inherit",
    }
  );
});

afterAll(async () => {
  // These tests break in CI for windows, so we're disabling them for now
  if (isWindows) return;

  await new Promise((resolve, reject) => {
    wranglerProcess.once("exit", (code) => {
      if (!code) {
        resolve(code);
      } else {
        reject(code);
      }
    });
    wranglerProcess.kill();
  });
});

it("renders", async () => {
  // These tests break in CI for windows, so we're disabling them for now
  if (isWindows) return;

  const response = await waitUntilReady("http://localhost:9001/");
  const text = await response.text();
  expect(text).toMatchInlineSnapshot(`
    "{
      \\"VAR1\\": \\"value1\\",
      \\"VAR2\\": 123,
      \\"VAR3\\": {
        \\"abc\\": \\"def\\"
      },
      \\"text\\": \\"Here be some text\\",
      \\"data\\": \\"Here be some data\\"
    }"
  `);
});
