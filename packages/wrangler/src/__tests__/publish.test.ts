import * as fs from "node:fs";
import * as path from "node:path";
import * as TOML from "@iarna/toml";
import { writeAuthConfigFile } from "../user";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import {
  createFetchResult,
  setMockRawResponse,
  setMockResponse,
  unsetAllMocks,
  unsetMockFetchKVGetValues,
} from "./helpers/mock-cfetch";
import { mockConsoleMethods } from "./helpers/mock-console";
import { mockKeyListRequest } from "./helpers/mock-kv";
import { mockOAuthFlow } from "./helpers/mock-oauth-flow";
import { runInTempDir } from "./helpers/run-in-tmp";
import { runWrangler } from "./helpers/run-wrangler";
import { writeWorkerSource } from "./helpers/write-worker-source";
import writeWranglerToml from "./helpers/write-wrangler-toml";
import type { Config } from "../config";
import type { WorkerMetadata } from "../create-worker-upload-form";
import type { KVNamespaceInfo } from "../kv";
import type { CfWorkerInit } from "../worker";
import type { FormData, File } from "undici";

describe("publish", () => {
  mockAccountId();
  mockApiToken();
  runInTempDir({ homedir: "./home" });
  const std = mockConsoleMethods();
  const {
    mockOAuthServerCallback,
    mockGrantAccessToken,
    mockGrantAuthorization,
  } = mockOAuthFlow();

  beforeEach(() => {
    // @ts-expect-error we're using a very simple setTimeout mock here
    jest.spyOn(global, "setTimeout").mockImplementation((fn, _period) => {
      setImmediate(fn);
    });
  });

  afterEach(() => {
    unsetAllMocks();
    unsetMockFetchKVGetValues();
  });

  describe("authentication", () => {
    mockApiToken({ apiToken: null });
    beforeEach(() => {
      // @ts-expect-error disable the mock we'd setup earlier
      // or else our server won't bother listening for oauth requests
      // and will timeout and fail
      global.setTimeout.mockRestore();
    });

    it("drops a user into the login flow if they're unauthenticated", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest();

      mockOAuthServerCallback();
      const accessTokenRequest = mockGrantAccessToken({ respondWith: "ok" });
      mockGrantAuthorization({ respondWith: "success" });

      await expect(runWrangler("publish index.js")).resolves.toBeUndefined();

      expect(accessTokenRequest.actual.url).toEqual(
        accessTokenRequest.expected.url
      );

      expect(std.out).toMatchInlineSnapshot(`
        "Attempting to login via OAuth...
        Successfully logged in.
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("warns a user when they're authenticated with an API token in wrangler config file", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest();
      writeAuthConfigFile({
        api_token: "some-api-token",
      });

      const accessTokenRequest = mockGrantAccessToken({ respondWith: "ok" });
      mockGrantAuthorization({ respondWith: "success" });

      await expect(runWrangler("publish index.js")).resolves.toBeUndefined();

      expect(accessTokenRequest.actual.url).toEqual(
        accessTokenRequest.expected.url
      );

      expect(std.out).toMatchInlineSnapshot(`
        "Attempting to login via OAuth...
        Successfully logged in.
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mIt looks like you have used Wrangler 1's \`config\` command to login with an API token.
        This is no longer supported in the current version of Wrangler.
        If you wish to authenticate via an API token then please set the \`CLOUDFLARE_API_TOKEN\` environment variable.[0m

        "
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("environments", () => {
    it("should use legacy environments by default", async () => {
      writeWranglerToml({ env: { "some-env": {} } });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        env: "some-env",
        legacyEnv: true,
      });
      await runWrangler("publish index.js --env some-env");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name-some-env (TIMINGS)
        Published test-name-some-env (TIMINGS)
          test-name-some-env.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    describe("legacy", () => {
      it("uses the script name when no environment is specified", async () => {
        writeWranglerToml();
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          legacyEnv: true,
        });
        await runWrangler("publish index.js --legacy-env true");
        expect(std.out).toMatchInlineSnapshot(`
          "Uploaded test-name (TIMINGS)
          Published test-name (TIMINGS)
            test-name.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("appends the environment name when provided, and there is associated config", async () => {
        writeWranglerToml({ env: { "some-env": {} } });
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          env: "some-env",
          legacyEnv: true,
        });
        await runWrangler("publish index.js --env some-env --legacy-env true");
        expect(std.out).toMatchInlineSnapshot(`
          "Uploaded test-name-some-env (TIMINGS)
          Published test-name-some-env (TIMINGS)
            test-name-some-env.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("appends the environment name when provided (with a warning), if there are no configured environments", async () => {
        writeWranglerToml({});
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          env: "some-env",
          legacyEnv: true,
        });
        await runWrangler("publish index.js --env some-env --legacy-env true");
        expect(std.out).toMatchInlineSnapshot(`
          "Uploaded test-name-some-env (TIMINGS)
          Published test-name-some-env (TIMINGS)
            test-name-some-env.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`
          "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
            - No environment found in configuration with name \\"some-env\\".
              Before using \`--env=some-env\` there should be an equivalent environment section in the configuration.

              Consider adding an environment configuration section to the wrangler.toml file:
              \`\`\`
              [env.some-env]
              \`\`\`
          [0m

          "
        `);
      });

      it("should throw an error when an environment name when provided, which doesn't match those in the config", async () => {
        writeWranglerToml({ env: { "other-env": {} } });
        writeWorkerSource();
        mockSubDomainRequest();
        await expect(
          runWrangler("publish index.js --env some-env --legacy-env true")
        ).rejects.toThrowErrorMatchingInlineSnapshot(`
                "Processing wrangler.toml configuration:
                  - No environment found in configuration with name \\"some-env\\".
                    Before using \`--env=some-env\` there should be an equivalent environment section in the configuration.
                    The available configured environment names are: [\\"other-env\\"]

                    Consider adding an environment configuration section to the wrangler.toml file:
                    \`\`\`
                    [env.some-env]
                    \`\`\`
                "
              `);
      });

      it("should throw an error w/ helpful message when using --env --name", async () => {
        writeWranglerToml({ env: { "some-env": {} } });
        writeWorkerSource();
        mockSubDomainRequest();
        await runWrangler(
          "publish index.js --name voyager --env some-env --legacy-env true"
        ).catch((err) =>
          expect(err).toMatchInlineSnapshot(`
            [Error: In legacy environment mode you cannot use --name and --env together. If you want to specify a Worker name for a specific environment you can add the following to your wrangler.toml config:
                [env.some-env]
                name = "voyager"
                ]
          `)
        );
      });
    });

    describe("services", () => {
      it("uses the script name when no environment is specified", async () => {
        writeWranglerToml();
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          legacyEnv: false,
        });
        await runWrangler("publish index.js --legacy-env false");
        expect(std.out).toMatchInlineSnapshot(`
          "Uploaded test-name (TIMINGS)
          Published test-name (TIMINGS)
            test-name.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`
          "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mService environments are in beta, and their behaviour is guaranteed to change in the future. DO NOT USE IN PRODUCTION.[0m

          "
        `);
      });

      it("publishes as an environment when provided", async () => {
        writeWranglerToml({ env: { "some-env": {} } });
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          env: "some-env",
          legacyEnv: false,
        });
        await runWrangler("publish index.js --env some-env --legacy-env false");
        expect(std.out).toMatchInlineSnapshot(`
          "Uploaded test-name (some-env) (TIMINGS)
          Published test-name (some-env) (TIMINGS)
            some-env.test-name.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`
          "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mService environments are in beta, and their behaviour is guaranteed to change in the future. DO NOT USE IN PRODUCTION.[0m

          "
        `);
      });
    });
  });

  it("should resolve wrangler.toml relative to the entrypoint", async () => {
    fs.mkdirSync("./some-path/worker", { recursive: true });
    fs.writeFileSync(
      "./some-path/wrangler.toml",
      TOML.stringify({
        name: "test-name",
        compatibility_date: "2022-01-12",
        vars: { xyz: 123 },
      }),
      "utf-8"
    );
    writeWorkerSource({ basePath: "./some-path/worker" });
    mockUploadWorkerRequest({
      expectedBindings: [
        {
          json: 123,
          name: "xyz",
          type: "json",
        },
      ],
      expectedCompatibilityDate: "2022-01-12",
    });
    mockSubDomainRequest();
    await runWrangler("publish ./some-path/worker/index.js");
    expect(std.out).toMatchInlineSnapshot(`
      "Uploaded test-name (TIMINGS)
      Published test-name (TIMINGS)
        test-name.test-sub-domain.workers.dev"
    `);
    expect(std.err).toMatchInlineSnapshot(`""`);
  });

  describe("routes", () => {
    it("should publish the worker to a route", async () => {
      writeWranglerToml({
        routes: ["example.com/some-route/*"],
      });
      writeWorkerSource();
      mockUpdateWorkerRequest({ enabled: false });
      mockUploadWorkerRequest({ expectedType: "esm" });
      mockPublishRoutesRequest({ routes: ["example.com/some-route/*"] });
      await runWrangler("publish ./index");
    });

    it("should publish to a route with a pattern/{zone_id|zone_name} combo", async () => {
      writeWranglerToml({
        routes: [
          "some-example.com/some-route/*",
          { pattern: "*a-boring-website.com", zone_id: "54sdf7fsda" },
          {
            pattern: "*another-boring-website.com",
            zone_name: "some-zone.com",
          },
          { pattern: "example.com/some-route/*", zone_id: "JGHFHG654gjcj" },
          "more-examples.com/*",
        ],
      });
      writeWorkerSource();
      mockUpdateWorkerRequest({ enabled: false });
      mockUploadWorkerRequest({ expectedType: "esm" });
      mockPublishRoutesRequest({
        routes: [
          "some-example.com/some-route/*",
          { pattern: "*a-boring-website.com", zone_id: "54sdf7fsda" },
          {
            pattern: "*another-boring-website.com",
            zone_name: "some-zone.com",
          },
          { pattern: "example.com/some-route/*", zone_id: "JGHFHG654gjcj" },
          "more-examples.com/*",
        ],
      });
      await runWrangler("publish ./index");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          some-example.com/some-route/*
          *a-boring-website.com (zone id: 54sdf7fsda)
          *another-boring-website.com (zone name: some-zone.com)
          example.com/some-route/* (zone id: JGHFHG654gjcj)
          more-examples.com/*",
          "warn": "",
        }
      `);
    });

    it("should publish to a route with a pattern/{zone_id|zone_name} combo (service environments)", async () => {
      writeWranglerToml({
        env: {
          staging: {
            routes: [
              "some-example.com/some-route/*",
              { pattern: "*a-boring-website.com", zone_id: "54sdf7fsda" },
              {
                pattern: "*another-boring-website.com",
                zone_name: "some-zone.com",
              },
              { pattern: "example.com/some-route/*", zone_id: "JGHFHG654gjcj" },
              "more-examples.com/*",
            ],
          },
        },
      });
      mockSubDomainRequest();
      writeWorkerSource();
      mockUpdateWorkerRequest({
        enabled: false,
        env: "staging",
        legacyEnv: false,
      });
      mockUploadWorkerRequest({
        expectedType: "esm",
        env: "staging",
        legacyEnv: false,
      });
      mockPublishRoutesRequest({
        routes: [
          "some-example.com/some-route/*",
          { pattern: "*a-boring-website.com", zone_id: "54sdf7fsda" },
          {
            pattern: "*another-boring-website.com",
            zone_name: "some-zone.com",
          },
          { pattern: "example.com/some-route/*", zone_id: "JGHFHG654gjcj" },
          "more-examples.com/*",
        ],
        env: "staging",
        legacyEnv: false,
      });
      await runWrangler("publish ./index --legacy-env false --env staging");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Uploaded test-name (staging) (TIMINGS)
        Published test-name (staging) (TIMINGS)
          some-example.com/some-route/*
          *a-boring-website.com (zone id: 54sdf7fsda)
          *another-boring-website.com (zone name: some-zone.com)
          example.com/some-route/* (zone id: JGHFHG654gjcj)
          more-examples.com/*",
          "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mService environments are in beta, and their behaviour is guaranteed to change in the future. DO NOT USE IN PRODUCTION.[0m

        ",
        }
      `);
    });

    it("should publish to legacy environment specific routes", async () => {
      writeWranglerToml({
        routes: ["example.com/some-route/*"],
        env: {
          dev: {
            routes: ["dev-example.com/some-route/*"],
          },
        },
      });
      writeWorkerSource();
      mockUpdateWorkerRequest({ enabled: false, legacyEnv: true, env: "dev" });
      mockUploadWorkerRequest({
        expectedType: "esm",
        legacyEnv: true,
        env: "dev",
      });
      mockPublishRoutesRequest({
        routes: ["dev-example.com/some-route/*"],
        legacyEnv: true,
        env: "dev",
      });
      await runWrangler("publish ./index --env dev --legacy-env true");
    });

    it("services: should publish to service environment specific routes", async () => {
      writeWranglerToml({
        routes: ["example.com/some-route/*"],
        env: {
          dev: {
            routes: ["dev-example.com/some-route/*"],
          },
        },
      });
      writeWorkerSource();
      mockUpdateWorkerRequest({ enabled: false, env: "dev" });
      mockUploadWorkerRequest({
        expectedType: "esm",
        env: "dev",
      });
      mockPublishRoutesRequest({
        routes: ["dev-example.com/some-route/*"],
        env: "dev",
      });
      await runWrangler("publish ./index --env dev --legacy-env false");
    });

    it.todo("should error if it's a workers.dev route");
  });

  describe("entry-points", () => {
    it("should be able to use `index` with no extension as the entry-point (esm)", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockUploadWorkerRequest({ expectedType: "esm" });
      mockSubDomainRequest();

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to use `index` with no extension as the entry-point (sw)", async () => {
      writeWranglerToml();
      writeWorkerSource({ type: "sw" });
      mockUploadWorkerRequest({ expectedType: "sw" });
      mockSubDomainRequest();

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to use the `main` config as the entry-point for ESM sources", async () => {
      writeWranglerToml({ main: "./index.js" });
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();

      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `main` relative to the wrangler.toml not cwd", async () => {
      writeWranglerToml({
        main: "./foo/index.js",
      });
      writeWorkerSource({ basePath: "foo" });
      mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
      mockSubDomainRequest();
      process.chdir("foo");
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it('should use `build.upload.main` as an entry point, where `build.upload.dir` defaults to "./dist", and log a deprecation warning', async () => {
      writeWranglerToml({ build: { upload: { main: "./index.js" } } });
      writeWorkerSource({ basePath: "./dist" });
      mockUploadWorkerRequest();
      mockSubDomainRequest();

      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
          - DEPRECATION: \\"build.upload.main\\":
            Delete the \`build.upload.main\` and \`build.upload.dir\` fields.
            Then add the top level \`main\` field to your configuration file:
            \`\`\`
            main = \\"dist/index.js\\"
            \`\`\`[0m

        "
      `);
    });

    it("should use `build.upload.main` relative to `build.upload.dir`", async () => {
      writeWranglerToml({
        build: {
          upload: {
            main: "./index.js",
            dir: "./foo",
          },
        },
      });
      writeWorkerSource({ basePath: "./foo" });
      mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
      mockSubDomainRequest();
      process.chdir("foo");
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing ../wrangler.toml configuration:
          - DEPRECATION: \\"build.upload.main\\":
            Delete the \`build.upload.main\` and \`build.upload.dir\` fields.
            Then add the top level \`main\` field to your configuration file:
            \`\`\`
            main = \\"foo/index.js\\"
            \`\`\`
          - DEPRECATION: \\"build.upload.dir\\":
            Use the top level \\"main\\" field or a command-line argument to specify the entry-point for the Worker.[0m

        "
      `);
    });

    it("should error when both `main` and `build.upload.main` are used", async () => {
      writeWranglerToml({
        main: "./index.js",
        build: {
          upload: {
            main: "./index.js",
            dir: "./foo",
          },
        },
      });
      await expect(runWrangler("publish")).rejects
        .toThrowErrorMatchingInlineSnapshot(`
              "Processing wrangler.toml configuration:
                - Don't define both the \`main\` and \`build.upload.main\` fields in your configuration.
                  They serve the same purpose: to point to the entry-point of your worker.
                  Delete the \`build.upload.main\` and \`build.upload.dir\` field from your config."
            `);
    });

    it("should be able to transpile TypeScript (esm)", async () => {
      writeWranglerToml();
      writeWorkerSource({ format: "ts" });
      mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
      mockSubDomainRequest();
      await runWrangler("publish index.ts");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to transpile TypeScript (sw)", async () => {
      writeWranglerToml();
      writeWorkerSource({ format: "ts", type: "sw" });
      mockUploadWorkerRequest({
        expectedEntry: "var foo = 100;",
        expectedType: "sw",
      });
      mockSubDomainRequest();
      await runWrangler("publish index.ts");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should add referenced text modules into the form upload", async () => {
      writeWranglerToml();
      fs.writeFileSync(
        "./index.js",
        `
import txt from './textfile.txt';
export default{
  fetch(){
    return new Response(txt);
  }
}
`
      );
      fs.writeFileSync("./textfile.txt", "Hello, World!");
      mockUploadWorkerRequest({
        expectedModules: {
          "./0a0a9f2a6772942557ab5355d76af442f8f65e01-textfile.txt":
            "Hello, World!",
        },
      });
      mockSubDomainRequest();
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to transpile entry-points in sub-directories (esm)", async () => {
      writeWranglerToml();
      writeWorkerSource({ basePath: "./src" });
      mockUploadWorkerRequest({ expectedEntry: "var foo = 100;" });
      mockSubDomainRequest();

      await runWrangler("publish ./src/index.js");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should be able to transpile entry-points in sub-directories (sw)", async () => {
      writeWranglerToml();
      writeWorkerSource({ basePath: "./src", type: "sw" });
      mockUploadWorkerRequest({
        expectedEntry: "var foo = 100;",
        expectedType: "sw",
      });
      mockSubDomainRequest();

      await runWrangler("publish ./src/index.js");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it('should error if a site definition doesn\'t have a "bucket" field', async () => {
      writeWranglerToml({
        // @ts-expect-error we're intentionally setting an invalid config
        site: {},
      });
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();

      await expect(runWrangler("publish ./index.js")).rejects
        .toThrowErrorMatchingInlineSnapshot(`
              "Processing wrangler.toml configuration:
                - \\"site.bucket\\" is a required field."
            `);

      expect(std.out).toMatchInlineSnapshot(`
        "
        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mProcessing wrangler.toml configuration:
          - \\"site.bucket\\" is a required field.[0m

        "
      `);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should error if there is a `site.entry-point` configuration", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };

      writeWranglerToml({
        site: {
          "entry-point": "./index.js",
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);

      await expect(runWrangler("publish ./index.js")).rejects
        .toThrowErrorMatchingInlineSnapshot(`
              "Processing wrangler.toml configuration:
                - NO LONGER SUPPORTED: \\"site.entry-point\\":
                  The \`site.entry-point\` config field is no longer used.
                  The entry-point should be specified via the command line or the \`main\` config field."
            `);

      expect(std.out).toMatchInlineSnapshot(`
        "
        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mProcessing wrangler.toml configuration:
          - NO LONGER SUPPORTED: \\"site.entry-point\\":
            The \`site.entry-point\` config field is no longer used.
            The entry-point should be specified via the command line or the \`main\` config field.[0m

        "
      `);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
          - Unexpected fields found in site field: \\"entry-point\\"[0m

        "
      `);
    });

    it("should error if there is no entry-point specified", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      await expect(
        runWrangler("publish")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Missing entry-point: The entry-point should be specified via the command line (e.g. \`wrangler publish path/to/script\`) or the \`main\` config field."`
      );

      expect(std.out).toMatchInlineSnapshot(`
        "
        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mMissing entry-point: The entry-point should be specified via the command line (e.g. \`wrangler publish path/to/script\`) or the \`main\` config field.[0m

        "
      `);
    });
  });

  describe("asset upload", () => {
    it("should upload all the files in the directory specified by `config.site.bucket`", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        Reading assets/file-2.txt...
        Uploading as assets/file-2.5938485188.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("when using a service-worker type, it should add an asset manifest as a text_blob, and bind to a namespace", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource({ type: "sw" });
      writeAssets(assets);
      mockUploadWorkerRequest({
        expectedType: "sw",
        expectedModules: {
          __STATIC_CONTENT_MANIFEST:
            '{"file-1.txt":"assets/file-1.2ca234f380.txt","file-2.txt":"assets/file-2.5938485188.txt"}',
        },
        expectedBindings: [
          {
            name: "__STATIC_CONTENT",
            namespace_id: "__test-name-workers_sites_assets-id",
            type: "kv_namespace",
          },
          {
            name: "__STATIC_CONTENT_MANIFEST",
            part: "__STATIC_CONTENT_MANIFEST",
            type: "text_blob",
          },
        ],
      });
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);

      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        Reading assets/file-2.txt...
        Uploading as assets/file-2.5938485188.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("when using a module worker type, it should add an asset manifest module, and bind to a namespace", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource({ type: "esm" });
      writeAssets(assets);
      mockUploadWorkerRequest({
        expectedBindings: [
          {
            name: "__STATIC_CONTENT",
            namespace_id: "__test-name-workers_sites_assets-id",
            type: "kv_namespace",
          },
        ],
        expectedModules: {
          __STATIC_CONTENT_MANIFEST:
            '{"file-1.txt":"assets/file-1.2ca234f380.txt","file-2.txt":"assets/file-2.5938485188.txt"}',
        },
      });
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);

      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        Reading assets/file-2.txt...
        Uploading as assets/file-2.5938485188.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should make environment specific kv namespace for assets, even for service envs", async () => {
      // This is the same test as the one before this, but with an env arg
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-some-env-workers_sites_assets",
        id: "__test-name-some-env-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
        env: { "some-env": {} },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest({
        env: "some-env",
        expectedBindings: [
          {
            name: "__STATIC_CONTENT",
            namespace_id: "__test-name-some-env-workers_sites_assets-id",
            type: "kv_namespace",
          },
        ],
      });
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);
      await runWrangler("publish --env some-env --legacy-env false");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        Reading assets/file-2.txt...
        Uploading as assets/file-2.5938485188.txt...
        ↗️  Done syncing assets
        Uploaded test-name (some-env) (TIMINGS)
        Published test-name (some-env) (TIMINGS)
          some-env.test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should make environment specific kv namespace for assets, even for legacy envs", async () => {
      // And this is the same test as the one before this, but with legacyEnv:true
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-some-env-workers_sites_assets",
        id: "__test-name-some-env-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
        env: { "some-env": {} },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest({
        legacyEnv: true,
        env: "some-env",
        expectedBindings: [
          {
            name: "__STATIC_CONTENT",
            namespace_id: "__test-name-some-env-workers_sites_assets-id",
            type: "kv_namespace",
          },
        ],
      });
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      mockUploadAssetsToKVRequest(kvNamespace.id, assets);
      await runWrangler("publish --env some-env --legacy-env true");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        Reading assets/file-2.txt...
        Uploading as assets/file-2.5938485188.txt...
        ↗️  Done syncing assets
        Uploaded test-name-some-env (TIMINGS)
        Published test-name-some-env (TIMINGS)
          test-name-some-env.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should only upload files that are not already in the KV namespace", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      // Put file-1 in the KV namespace
      mockKeyListRequest(kvNamespace.id, [
        { name: "assets/file-1.2ca234f380.txt" },
      ]);
      // Check we do not upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath !== "assets/file-1.txt")
      );
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Skipping - already uploaded.
        Reading assets/file-2.txt...
        Uploading as assets/file-2.5938485188.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should only upload files that match the `site-include` arg", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish --site-include file-1.txt");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should not upload files that match the `site-exclude` arg", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish --site-exclude file-2.txt");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should only upload files that match the `site.include` config", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
          include: ["file-1.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should not upload files that match the `site.exclude` config", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
          exclude: ["file-2.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `site-include` arg over `site.include` config", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
          include: ["file-2.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath === "assets/file-1.txt")
      );
      await runWrangler("publish --site-include file-1.txt");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `site-exclude` arg over `site.exclude` config", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
          exclude: ["assets/file-1.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Check we only upload file-1
      mockUploadAssetsToKVRequest(
        kvNamespace.id,
        assets.filter((a) => a.filePath.endsWith("assets/file-1.txt"))
      );
      await runWrangler("publish --site-exclude file-2.txt");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Uploading as assets/file-1.2ca234f380.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should walk directories except node_modules", async () => {
      const assets = [
        {
          filePath: "assets/directory-1/file-1.txt",
          content: "Content of file-1",
        },
        {
          filePath: "assets/node_modules/file-2.txt",
          content: "Content of file-2",
        },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Only expect file-1 to be uploaded
      mockUploadAssetsToKVRequest(kvNamespace.id, assets.slice(0, 1));
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/directory-1/file-1.txt...
        Uploading as assets/directory-1/file-1.2ca234f380.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should skip hidden files and directories except `.well-known`", async () => {
      const assets = [
        {
          filePath: "assets/.hidden-file.txt",
          content: "Content of hidden-file",
        },
        {
          filePath: "assets/.hidden/file-1.txt",
          content: "Content of file-1",
        },
        {
          filePath: "assets/.well-known/file-2.txt",
          content: "Content of file-2",
        },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);
      // Only expect file-2 to be uploaded
      mockUploadAssetsToKVRequest(kvNamespace.id, assets.slice(2));
      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/.well-known/file-2.txt...
        Uploading as assets/.well-known/file-2.5938485188.txt...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should error if the asset is over 25Mb", async () => {
      const assets = [
        {
          filePath: "assets/large-file.txt",
          // This file is greater than 25MiB when base64 encoded but small enough to be uploaded.
          content: "X".repeat(25 * 1024 * 1024 * 0.8 + 1),
        },
        {
          filePath: "assets/too-large-file.txt",
          content: "X".repeat(25 * 1024 * 1024 + 1),
        },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
          exclude: ["assets/file-1.txt"],
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);

      await expect(
        runWrangler("publish")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"File assets/too-large-file.txt is too big, it should be under 25 MiB. See https://developers.cloudflare.com/workers/platform/limits#kv-limits"`
      );

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/large-file.txt...
        Uploading as assets/large-file.0ea0637a45.txt...

        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mFile assets/too-large-file.txt is too big, it should be under 25 MiB. See https://developers.cloudflare.com/workers/platform/limits#kv-limits[0m

        "
      `);
    });

    it("should error if the asset key is over 512 characters", async () => {
      const longFilePathAsset = {
        filePath: "assets/" + "folder/".repeat(100) + "file.txt",
        content: "content of file",
      };
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets([longFilePathAsset]);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, []);

      await expect(
        runWrangler("publish")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"The asset path key \\"assets/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/file.3da0d0cd12.txt\\" exceeds the maximum key size limit of 512. See https://developers.cloudflare.com/workers/platform/limits#kv-limits\\","`
      );

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/file.txt...

        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mThe asset path key \\"assets/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/folder/file.3da0d0cd12.txt\\" exceeds the maximum key size limit of 512. See https://developers.cloudflare.com/workers/platform/limits#kv-limits\\",[0m

        "
      `);
    });

    it("should delete uploaded assets that aren't included anymore", async () => {
      const assets = [
        { filePath: "assets/file-1.txt", content: "Content of file-1" },
        { filePath: "assets/file-2.txt", content: "Content of file-2" },
      ];
      const kvNamespace = {
        title: "__test-name-workers_sites_assets",
        id: "__test-name-workers_sites_assets-id",
      };
      writeWranglerToml({
        main: "./index.js",
        site: {
          bucket: "assets",
        },
      });
      writeWorkerSource();
      writeAssets(assets);
      mockUploadWorkerRequest();
      mockSubDomainRequest();
      mockListKVNamespacesRequest(kvNamespace);
      mockKeyListRequest(kvNamespace.id, [
        // Put file-1 in the KV namespace
        { name: "assets/file-1.2ca234f380.txt" },
        // As well as a couple from a previous upload
        { name: "assets/file-3.somehash.txt" },
        { name: "assets/file-4.anotherhash.txt" },
      ]);

      // we upload only file-1.txt
      mockUploadAssetsToKVRequest(kvNamespace.id, [
        ...assets.filter((a) => a.filePath !== "assets/file-1.txt"),
      ]);

      // and mark file-3 and file-4 for deletion
      mockDeleteUnusedAssetsRequest(kvNamespace.id, [
        "assets/file-3.somehash.txt",
        "assets/file-4.anotherhash.txt",
      ]);

      await runWrangler("publish");

      expect(std.out).toMatchInlineSnapshot(`
        "Reading assets/file-1.txt...
        Skipping - already uploaded.
        Reading assets/file-2.txt...
        Uploading as assets/file-2.5938485188.txt...
        Deleting assets/file-3.somehash.txt from the asset store...
        Deleting assets/file-4.anotherhash.txt from the asset store...
        ↗️  Done syncing assets
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("workers_dev setting", () => {
    it("should publish to a workers.dev domain if workers_dev is undefined", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest();

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should publish to the workers.dev domain if workers_dev is `true`", async () => {
      writeWranglerToml({
        workers_dev: true,
      });
      writeWorkerSource();
      mockUploadWorkerRequest({ available_on_subdomain: false });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true });

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should not try to enable the workers.dev domain if it has been enabled before", async () => {
      writeWranglerToml({
        workers_dev: true,
      });
      writeWorkerSource();
      mockUploadWorkerRequest({ available_on_subdomain: true });
      mockSubDomainRequest();

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should disable the workers.dev domain if workers_dev is `false`", async () => {
      writeWranglerToml({
        workers_dev: false,
      });
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockUpdateWorkerRequest({ enabled: false });

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        No publish targets for test-name (TIMINGS)"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should not try to disable the workers.dev domain if it is not already available", async () => {
      writeWranglerToml({
        workers_dev: false,
      });
      writeWorkerSource();
      mockSubDomainRequest("test-sub-domain", false);
      mockUploadWorkerRequest({ available_on_subdomain: false });

      // note the lack of a mock for the subdomain disable request

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        No publish targets for test-name (TIMINGS)"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should disable the workers.dev domain if workers_dev is undefined but overwritten to `false` in environment", async () => {
      writeWranglerToml({
        env: {
          dev: {
            workers_dev: false,
          },
        },
      });
      writeWorkerSource();
      mockUploadWorkerRequest({
        env: "dev",
      });
      mockUpdateWorkerRequest({ enabled: false, env: "dev" });

      await runWrangler("publish ./index --env dev --legacy-env false");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (dev) (TIMINGS)
        No publish targets for test-name (dev) (TIMINGS)"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should disable the workers.dev domain if workers_dev is `true` but overwritten to `false` in environment", async () => {
      writeWranglerToml({
        workers_dev: true,
        env: {
          dev: {
            workers_dev: false,
          },
        },
      });
      writeWorkerSource();
      mockUploadWorkerRequest({
        env: "dev",
      });
      mockUpdateWorkerRequest({ enabled: false, env: "dev" });

      await runWrangler("publish ./index --env dev --legacy-env false");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (dev) (TIMINGS)
        No publish targets for test-name (dev) (TIMINGS)"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should publish to a workers.dev domain if workers_dev is undefined but overwritten to `true` in environment", async () => {
      writeWranglerToml({
        env: {
          dev: {
            workers_dev: true,
          },
        },
      });
      writeWorkerSource();
      mockUploadWorkerRequest({
        env: "dev",
      });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true, env: "dev" });

      await runWrangler("publish ./index --env dev --legacy-env false");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (dev) (TIMINGS)
        Published test-name (dev) (TIMINGS)
          dev.test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should publish to a workers.dev domain if workers_dev is `false` but overwritten to `true` in environment", async () => {
      writeWranglerToml({
        workers_dev: false,
        env: {
          dev: {
            workers_dev: true,
          },
        },
      });
      writeWorkerSource();
      mockUploadWorkerRequest({
        env: "dev",
      });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true, env: "dev" });

      await runWrangler("publish ./index --env dev --legacy-env false");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (dev) (TIMINGS)
        Published test-name (dev) (TIMINGS)
          dev.test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use the global compatibility_date and compatibility_flags if they are not overwritten by the environment", async () => {
      writeWranglerToml({
        compatibility_date: "2022-01-12",
        compatibility_flags: ["no_global_navigator"],
        env: {
          dev: {},
        },
      });
      writeWorkerSource();
      mockUploadWorkerRequest({
        env: "dev",
        expectedCompatibilityDate: "2022-01-12",
        expectedCompatibilityFlags: ["no_global_navigator"],
      });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true, env: "dev" });

      await runWrangler("publish ./index --env dev --legacy-env false");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (dev) (TIMINGS)
        Published test-name (dev) (TIMINGS)
          dev.test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use the environment specific compatibility_date and compatibility_flags", async () => {
      writeWranglerToml({
        compatibility_date: "2022-01-12",
        compatibility_flags: ["no_global_navigator"],
        env: {
          dev: {
            compatibility_date: "2022-01-13",
            compatibility_flags: ["global_navigator"],
          },
        },
      });
      writeWorkerSource();
      mockUploadWorkerRequest({
        env: "dev",
        expectedCompatibilityDate: "2022-01-13",
        expectedCompatibilityFlags: ["global_navigator"],
      });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true, env: "dev" });

      await runWrangler("publish ./index --env dev --legacy-env false");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (dev) (TIMINGS)
        Published test-name (dev) (TIMINGS)
          dev.test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use the command line --compatibility-date and --compatibility-flags if they are specified", async () => {
      writeWranglerToml({
        compatibility_date: "2022-01-12",
        compatibility_flags: ["no_global_navigator"],
        env: {
          dev: {
            compatibility_date: "2022-01-13",
            compatibility_flags: ["global_navigator"],
          },
        },
      });
      writeWorkerSource();
      mockUploadWorkerRequest({
        env: "dev",
        expectedCompatibilityDate: "2022-01-14",
        expectedCompatibilityFlags: ["url_standard"],
      });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true, env: "dev" });

      await runWrangler(
        "publish ./index --env dev --legacy-env false --compatibility-date 2022-01-14 --compatibility-flags url_standard"
      );

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (dev) (TIMINGS)
        Published test-name (dev) (TIMINGS)
          dev.test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should enable the workers.dev domain if workers_dev is undefined and subdomain is not already available", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockUploadWorkerRequest({ available_on_subdomain: false });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true });

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should enable the workers.dev domain if workers_dev is true and subdomain is not already available", async () => {
      writeWranglerToml({ workers_dev: true });
      writeWorkerSource();
      mockUploadWorkerRequest({ available_on_subdomain: false });
      mockSubDomainRequest();
      mockUpdateWorkerRequest({ enabled: true });

      await runWrangler("publish ./index");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should error politely when publishing to workers_dev when there is no workers.dev subdomain", async () => {
      writeWranglerToml({
        workers_dev: true,
      });
      writeWorkerSource();
      mockUploadWorkerRequest();
      mockSubDomainRequest("does-not-exist", false);

      await expect(runWrangler("publish ./index")).rejects
        .toThrowErrorMatchingInlineSnapshot(`
              "Error: You need to register a workers.dev subdomain before publishing to workers.dev
              You can either publish your worker to one or more routes by specifying them in wrangler.toml, or register a workers.dev subdomain here:
              https://dash.cloudflare.com/some-account-id/workers/onboarding"
            `);
    });

    it("should not deploy to workers.dev if there are any routes defined", async () => {
      writeWranglerToml({
        routes: ["http://example.com/*"],
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest();
      mockUpdateWorkerRequest({
        enabled: false,
      });
      mockPublishRoutesRequest({ routes: ["http://example.com/*"] });
      await runWrangler("publish index.js");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          http://example.com/*"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should not deploy to workers.dev if there are any routes defined (environments)", async () => {
      writeWranglerToml({
        routes: ["http://example.com/*"],
        env: {
          production: {
            routes: ["http://production.example.com/*"],
          },
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({ env: "production", legacyEnv: true });
      mockUpdateWorkerRequest({
        enabled: false,
        env: "production",
        legacyEnv: true,
      });
      mockPublishRoutesRequest({
        routes: ["http://production.example.com/*"],
        env: "production",
        legacyEnv: true,
      });
      await runWrangler("publish index.js --env production");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name-production (TIMINGS)
        Published test-name-production (TIMINGS)
          http://production.example.com/*"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should not deploy to workers.dev if there are any routes defined (only in environments)", async () => {
      writeWranglerToml({
        env: {
          production: {
            routes: ["http://production.example.com/*"],
          },
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({ env: "production", legacyEnv: true });
      mockUpdateWorkerRequest({
        enabled: false,
        env: "production",
        legacyEnv: true,
      });
      mockPublishRoutesRequest({
        routes: ["http://production.example.com/*"],
        env: "production",
        legacyEnv: true,
      });
      await runWrangler("publish index.js --env production");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name-production (TIMINGS)
        Published test-name-production (TIMINGS)
          http://production.example.com/*"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("can deploy to both workers.dev and routes if both defined ", async () => {
      writeWranglerToml({
        workers_dev: true,
        routes: ["http://example.com/*"],
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest();
      mockUpdateWorkerRequest({
        enabled: false,
      });
      mockPublishRoutesRequest({
        routes: ["http://example.com/*"],
      });
      await runWrangler("publish index.js");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev
          http://example.com/*"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("can deploy to both workers.dev and routes if both defined (environments: 1)", async () => {
      writeWranglerToml({
        workers_dev: true,
        env: {
          production: {
            routes: ["http://production.example.com/*"],
          },
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({ env: "production", legacyEnv: true });
      mockUpdateWorkerRequest({
        enabled: false,
        env: "production",
        legacyEnv: true,
      });
      mockPublishRoutesRequest({
        routes: ["http://production.example.com/*"],
        env: "production",
        legacyEnv: true,
      });
      await runWrangler("publish index.js --env production");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name-production (TIMINGS)
        Published test-name-production (TIMINGS)
          test-name-production.test-sub-domain.workers.dev
          http://production.example.com/*"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("can deploy to both workers.dev and routes if both defined (environments: 2)", async () => {
      writeWranglerToml({
        env: {
          production: {
            workers_dev: true,
            routes: ["http://production.example.com/*"],
          },
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({ env: "production", legacyEnv: true });
      mockUpdateWorkerRequest({
        enabled: false,
        env: "production",
        legacyEnv: true,
      });
      mockPublishRoutesRequest({
        routes: ["http://production.example.com/*"],
        env: "production",
        legacyEnv: true,
      });
      await runWrangler("publish index.js --env production");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name-production (TIMINGS)
        Published test-name-production (TIMINGS)
          test-name-production.test-sub-domain.workers.dev
          http://production.example.com/*"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("will deploy only to routes when workers_dev is false (environments 1) ", async () => {
      writeWranglerToml({
        workers_dev: false,
        env: {
          production: {
            routes: ["http://production.example.com/*"],
          },
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({ env: "production", legacyEnv: true });
      mockUpdateWorkerRequest({
        enabled: false,
        env: "production",
        legacyEnv: true,
      });
      mockPublishRoutesRequest({
        routes: ["http://production.example.com/*"],
        env: "production",
        legacyEnv: true,
      });
      await runWrangler("publish index.js --env production");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name-production (TIMINGS)
        Published test-name-production (TIMINGS)
          http://production.example.com/*"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("will deploy only to routes when workers_dev is false (environments 2) ", async () => {
      writeWranglerToml({
        env: {
          production: {
            workers_dev: false,
            routes: ["http://production.example.com/*"],
          },
        },
      });
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest({ env: "production", legacyEnv: true });
      mockUpdateWorkerRequest({
        enabled: false,
        env: "production",
        legacyEnv: true,
      });
      mockPublishRoutesRequest({
        routes: ["http://production.example.com/*"],
        env: "production",
        legacyEnv: true,
      });
      await runWrangler("publish index.js --env production");

      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name-production (TIMINGS)
        Published test-name-production (TIMINGS)
          http://production.example.com/*"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });
  });

  describe("custom builds", () => {
    beforeEach(() => {
      // @ts-expect-error disable the mock we'd setup earlier
      // or else custom builds will timeout immediately
      global.setTimeout.mockRestore();
    });
    it("should run a custom build before publishing", async () => {
      writeWranglerToml({
        build: {
          command: `node -e "console.log('custom build'); require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')"`,
        },
      });

      mockUploadWorkerRequest({
        expectedEntry: "return new Response(123)",
      });
      mockSubDomainRequest();

      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Running custom build: node -e \\"console.log('custom build'); require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')\\"
        Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    if (process.platform !== "win32") {
      it("should run a custom build of multiple steps combined by && before publishing", async () => {
        writeWranglerToml({
          build: {
            command: `echo "custom build" && echo "export default { fetch(){ return new Response(123) } }" > index.js`,
          },
        });

        mockUploadWorkerRequest({
          expectedEntry: "return new Response(123)",
        });
        mockSubDomainRequest();

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
          "Running custom build: echo \\"custom build\\" && echo \\"export default { fetch(){ return new Response(123) } }\\" > index.js
          Uploaded test-name (TIMINGS)
          Published test-name (TIMINGS)
            test-name.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    }

    it("should throw an error if the entry doesn't exist after the build finishes", async () => {
      writeWranglerToml({
        main: "index.js",
        build: {
          command: `node -e "console.log('custom build');"`,
        },
      });

      await expect(
        runWrangler("publish index.js")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Could not resolve \\"index.js\\" after running custom build: node -e \\"console.log('custom build');\\""`
      );
      expect(std.out).toMatchInlineSnapshot(`
        "Running custom build: node -e \\"console.log('custom build');\\"

        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mCould not resolve \\"index.js\\" after running custom build: node -e \\"console.log('custom build');\\"[0m

        "
      `);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should minify the script when `--minify` is true (sw)", async () => {
      writeWranglerToml({
        main: "./index.js",
      });
      fs.writeFileSync(
        "./index.js",
        `export
        default {
          fetch() {
            return new Response(     "hello Cpt Picard"     )
                  }
            }
        `
      );

      mockUploadWorkerRequest({
        expectedEntry: 'fetch(){return new Response("hello Cpt Picard")',
      });

      mockSubDomainRequest();
      await runWrangler("publish index.js --minify");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should minify the script when `minify` in config is true (esm)", async () => {
      writeWranglerToml({
        main: "./index.js",
        legacy_env: false,
        env: {
          testEnv: {
            minify: true,
          },
        },
      });
      fs.writeFileSync(
        "./index.js",
        `export
        default {
          fetch() {
            return new Response(     "hello Cpt Picard"     )
                  }
            }
        `
      );

      mockUploadWorkerRequest({
        env: "testEnv",
        expectedType: "esm",
        legacyEnv: false,
        expectedEntry: `fetch(){return new Response("hello Cpt Picard")`,
      });

      mockSubDomainRequest();
      await runWrangler("publish -e testEnv index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (testEnv) (TIMINGS)
        Published test-name (testEnv) (TIMINGS)
          testEnv.test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("durable object migrations", () => {
    it("should warn when you try to publish durable objects without migrations", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [{ name: "SOMENAME", class_name: "SomeClass" }],
        },
      });
      fs.writeFileSync(
        "index.js",
        `export class SomeClass{}; export default {};`
      );
      mockSubDomainRequest();
      mockUploadWorkerRequest();
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mIn wrangler.toml, you have configured [durable_objects] exported by this Worker (SomeClass), but no [migrations] for them. This may not work as expected until you add a [migrations] section to your wrangler.toml. Refer to https://developers.cloudflare.com/workers/learning/using-durable-objects/#durable-object-migrations-in-wranglertoml for more details.[0m

        "
      `);
    });

    it("does not warn if all the durable object bindings are to external classes", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [
            {
              name: "SOMENAME",
              class_name: "SomeClass",
              script_name: "some-script",
            },
          ],
        },
      });
      fs.writeFileSync(
        "index.js",
        `export class SomeClass{}; export default {};`
      );
      mockSubDomainRequest();
      mockUploadWorkerRequest();
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should publish all migrations on first publish", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [
            { name: "SOMENAME", class_name: "SomeClass" },
            { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
          ],
        },
        migrations: [
          { tag: "v1", new_classes: ["SomeClass"] },
          { tag: "v2", new_classes: ["SomeOtherClass"] },
        ],
      });
      fs.writeFileSync(
        "index.js",
        `export class SomeClass{}; export class SomeOtherClass{}; export default {};`
      );
      mockSubDomainRequest();
      mockLegacyScriptData({ scripts: [] }); // no previously uploaded scripts at all
      mockUploadWorkerRequest({
        expectedMigrations: {
          new_tag: "v2",
          steps: [
            { new_classes: ["SomeClass"] },
            { new_classes: ["SomeOtherClass"] },
          ],
        },
      });

      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should upload migrations past a previously uploaded tag", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [
            { name: "SOMENAME", class_name: "SomeClass" },
            { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
          ],
        },
        migrations: [
          { tag: "v1", new_classes: ["SomeClass"] },
          { tag: "v2", new_classes: ["SomeOtherClass"] },
        ],
      });
      fs.writeFileSync(
        "index.js",
        `export class SomeClass{}; export class SomeOtherClass{}; export default {};`
      );
      mockSubDomainRequest();
      mockLegacyScriptData({
        scripts: [{ id: "test-name", migration_tag: "v1" }],
      });
      mockUploadWorkerRequest({
        expectedMigrations: {
          old_tag: "v1",
          new_tag: "v2",
          steps: [
            {
              new_classes: ["SomeOtherClass"],
            },
          ],
        },
      });

      await runWrangler("publish index.js");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev",
          "warn": "",
        }
      `);
    });

    it("should not send migrations if they've all already been sent", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [
            { name: "SOMENAME", class_name: "SomeClass" },
            { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
          ],
        },
        migrations: [
          { tag: "v1", new_classes: ["SomeClass"] },
          { tag: "v2", new_classes: ["SomeOtherClass"] },
          { tag: "v3", new_classes: ["YetAnotherClass"] },
        ],
      });
      fs.writeFileSync(
        "index.js",
        `export class SomeClass{}; export class SomeOtherClass{}; export class YetAnotherClass{}; export default {};`
      );
      mockSubDomainRequest();
      mockLegacyScriptData({
        scripts: [{ id: "test-name", migration_tag: "v3" }],
      });
      mockUploadWorkerRequest({
        expectedMigrations: undefined,
      });

      await runWrangler("publish index.js");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev",
          "warn": "",
        }
      `);
    });

    describe("service environments", () => {
      it("should publish all migrations on first publish", async () => {
        writeWranglerToml({
          durable_objects: {
            bindings: [
              { name: "SOMENAME", class_name: "SomeClass" },
              { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
            ],
          },
          migrations: [
            { tag: "v1", new_classes: ["SomeClass"] },
            { tag: "v2", new_classes: ["SomeOtherClass"] },
          ],
        });
        fs.writeFileSync(
          "index.js",
          `export class SomeClass{}; export class SomeOtherClass{}; export default {};`
        );
        mockSubDomainRequest();
        mockServiceScriptData({}); // no scripts at all
        mockUploadWorkerRequest({
          legacyEnv: false,
          expectedMigrations: {
            new_tag: "v2",
            steps: [
              { new_classes: ["SomeClass"] },
              { new_classes: ["SomeOtherClass"] },
            ],
          },
        });

        await runWrangler("publish index.js --legacy-env false");
        expect(std.out).toMatchInlineSnapshot(`
          "Uploaded test-name (TIMINGS)
          Published test-name (TIMINGS)
            test-name.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`
          "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mService environments are in beta, and their behaviour is guaranteed to change in the future. DO NOT USE IN PRODUCTION.[0m

          "
        `);
      });

      it("should publish all migrations on first publish (--env)", async () => {
        writeWranglerToml({
          durable_objects: {
            bindings: [
              { name: "SOMENAME", class_name: "SomeClass" },
              { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
            ],
          },
          env: {
            xyz: {
              durable_objects: {
                bindings: [
                  { name: "SOMENAME", class_name: "SomeClass" },
                  { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
                ],
              },
            },
          },
          migrations: [
            { tag: "v1", new_classes: ["SomeClass"] },
            { tag: "v2", new_classes: ["SomeOtherClass"] },
          ],
        });
        fs.writeFileSync(
          "index.js",
          `export class SomeClass{}; export class SomeOtherClass{}; export default {};`
        );
        mockSubDomainRequest();
        mockServiceScriptData({ env: "xyz" }); // no scripts at all
        mockUploadWorkerRequest({
          legacyEnv: false,
          env: "xyz",
          expectedMigrations: {
            new_tag: "v2",
            steps: [
              { new_classes: ["SomeClass"] },
              { new_classes: ["SomeOtherClass"] },
            ],
          },
        });

        await runWrangler("publish index.js --legacy-env false --env xyz");
        expect(std.out).toMatchInlineSnapshot(`
          "Uploaded test-name (xyz) (TIMINGS)
          Published test-name (xyz) (TIMINGS)
            xyz.test-name.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`
          "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mService environments are in beta, and their behaviour is guaranteed to change in the future. DO NOT USE IN PRODUCTION.[0m

          "
        `);
      });

      it("should use a script's current migration tag when publishing migrations", async () => {
        writeWranglerToml({
          durable_objects: {
            bindings: [
              { name: "SOMENAME", class_name: "SomeClass" },
              { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
            ],
          },
          migrations: [
            { tag: "v1", new_classes: ["SomeClass"] },
            { tag: "v2", new_classes: ["SomeOtherClass"] },
          ],
        });
        fs.writeFileSync(
          "index.js",
          `export class SomeClass{}; export class SomeOtherClass{}; export default {};`
        );
        mockSubDomainRequest();
        mockServiceScriptData({
          script: { id: "test-name", migration_tag: "v1" },
        });
        mockUploadWorkerRequest({
          legacyEnv: false,
          expectedMigrations: {
            old_tag: "v1",
            new_tag: "v2",
            steps: [
              {
                new_classes: ["SomeOtherClass"],
              },
            ],
          },
        });

        await runWrangler("publish index.js --legacy-env false");
        expect(std).toMatchInlineSnapshot(`
          Object {
            "debug": "",
            "err": "",
            "out": "Uploaded test-name (TIMINGS)
          Published test-name (TIMINGS)
            test-name.test-sub-domain.workers.dev",
            "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mService environments are in beta, and their behaviour is guaranteed to change in the future. DO NOT USE IN PRODUCTION.[0m

          ",
          }
        `);
      });

      it("should use an environment's current migration tag when publishing migrations", async () => {
        writeWranglerToml({
          durable_objects: {
            bindings: [
              { name: "SOMENAME", class_name: "SomeClass" },
              { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
            ],
          },
          env: {
            xyz: {
              durable_objects: {
                bindings: [
                  { name: "SOMENAME", class_name: "SomeClass" },
                  { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
                ],
              },
            },
          },
          migrations: [
            { tag: "v1", new_classes: ["SomeClass"] },
            { tag: "v2", new_classes: ["SomeOtherClass"] },
          ],
        });
        fs.writeFileSync(
          "index.js",
          `export class SomeClass{}; export class SomeOtherClass{}; export default {};`
        );
        mockSubDomainRequest();
        mockServiceScriptData({
          script: { id: "test-name", migration_tag: "v1" },
          env: "xyz",
        });
        mockUploadWorkerRequest({
          legacyEnv: false,
          env: "xyz",
          expectedMigrations: {
            old_tag: "v1",
            new_tag: "v2",
            steps: [
              {
                new_classes: ["SomeOtherClass"],
              },
            ],
          },
        });

        await runWrangler("publish index.js --legacy-env false --env xyz");
        expect(std).toMatchInlineSnapshot(`
          Object {
            "debug": "",
            "err": "",
            "out": "Uploaded test-name (xyz) (TIMINGS)
          Published test-name (xyz) (TIMINGS)
            xyz.test-name.test-sub-domain.workers.dev",
            "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mService environments are in beta, and their behaviour is guaranteed to change in the future. DO NOT USE IN PRODUCTION.[0m

          ",
          }
        `);
      });
    });
  });

  describe("bindings", () => {
    it("should allow bindings with different names", async () => {
      writeWranglerToml({
        migrations: [
          {
            tag: "v1",
            new_classes: ["SomeDurableObject", "AnotherDurableObject"],
          },
        ],
        durable_objects: {
          bindings: [
            {
              name: "DURABLE_OBJECT_ONE",
              class_name: "SomeDurableObject",
              script_name: "some-durable-object-worker",
            },
            {
              name: "DURABLE_OBJECT_TWO",
              class_name: "AnotherDurableObject",
              script_name: "another-durable-object-worker",
            },
          ],
        },
        kv_namespaces: [
          { binding: "KV_NAMESPACE_ONE", id: "kv-ns-one-id" },
          { binding: "KV_NAMESPACE_TWO", id: "kv-ns-two-id" },
        ],
        r2_buckets: [
          { binding: "R2_BUCKET_ONE", bucket_name: "r2-bucket-one-name" },
          { binding: "R2_BUCKET_TWO", bucket_name: "r2-bucket-two-name" },
        ],
        text_blobs: {
          TEXT_BLOB_ONE: "./my-entire-app-depends-on-this.cfg",
          TEXT_BLOB_TWO: "./the-entirety-of-human-knowledge.txt",
        },
        unsafe: {
          bindings: [
            {
              name: "UNSAFE_BINDING_ONE",
              type: "some unsafe thing",
              data: { some: { unsafe: "thing" } },
            },
            {
              name: "UNSAFE_BINDING_TWO",
              type: "another unsafe thing",
              data: 1337,
            },
          ],
        },
        vars: {
          ENV_VAR_ONE: 123,
          ENV_VAR_TWO: "Hello, I'm an environment variable",
        },
        wasm_modules: {
          WASM_MODULE_ONE: "./some_wasm.wasm",
          WASM_MODULE_TWO: "./more_wasm.wasm",
        },
        data_blobs: {
          DATA_BLOB_ONE: "./some-data-blob.bin",
          DATA_BLOB_TWO: "./more-data-blob.bin",
        },
      });

      writeWorkerSource({ type: "sw" });
      fs.writeFileSync("./my-entire-app-depends-on-this.cfg", "config = value");
      fs.writeFileSync(
        "./the-entirety-of-human-knowledge.txt",
        "Everything's bigger in Texas"
      );
      fs.writeFileSync("./some_wasm.wasm", "some wasm");
      fs.writeFileSync("./more_wasm.wasm", "more wasm");

      fs.writeFileSync("./some-data-blob.bin", "some data");
      fs.writeFileSync("./more-data-blob.bin", "more data");

      mockUploadWorkerRequest({
        expectedType: "sw",
        expectedBindings: [
          {
            name: "KV_NAMESPACE_ONE",
            namespace_id: "kv-ns-one-id",
            type: "kv_namespace",
          },
          {
            name: "KV_NAMESPACE_TWO",
            namespace_id: "kv-ns-two-id",
            type: "kv_namespace",
          },
          {
            class_name: "SomeDurableObject",
            name: "DURABLE_OBJECT_ONE",
            script_name: "some-durable-object-worker",
            type: "durable_object_namespace",
          },
          {
            class_name: "AnotherDurableObject",
            name: "DURABLE_OBJECT_TWO",
            script_name: "another-durable-object-worker",
            type: "durable_object_namespace",
          },
          {
            bucket_name: "r2-bucket-one-name",
            name: "R2_BUCKET_ONE",
            type: "r2_bucket",
          },
          {
            bucket_name: "r2-bucket-two-name",
            name: "R2_BUCKET_TWO",
            type: "r2_bucket",
          },
          { json: 123, name: "ENV_VAR_ONE", type: "json" },
          {
            name: "ENV_VAR_TWO",
            text: "Hello, I'm an environment variable",
            type: "plain_text",
          },
          {
            name: "WASM_MODULE_ONE",
            part: "WASM_MODULE_ONE",
            type: "wasm_module",
          },
          {
            name: "WASM_MODULE_TWO",
            part: "WASM_MODULE_TWO",
            type: "wasm_module",
          },
          { name: "TEXT_BLOB_ONE", part: "TEXT_BLOB_ONE", type: "text_blob" },
          { name: "TEXT_BLOB_TWO", part: "TEXT_BLOB_TWO", type: "text_blob" },
          { name: "DATA_BLOB_ONE", part: "DATA_BLOB_ONE", type: "data_blob" },
          { name: "DATA_BLOB_TWO", part: "DATA_BLOB_TWO", type: "data_blob" },
          {
            data: { some: { unsafe: "thing" } },
            name: "UNSAFE_BINDING_ONE",
            type: "some unsafe thing",
          },
          {
            data: 1337,
            name: "UNSAFE_BINDING_TWO",
            type: "another unsafe thing",
          },
        ],
      });
      mockSubDomainRequest();
      mockLegacyScriptData({ scripts: [] });

      await expect(runWrangler("publish index.js")).resolves.toBeUndefined();
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
          - \\"unsafe\\" fields are experimental and may change or break at any time.[0m

        "
      `);
    });

    it("should error when bindings of different types have the same name", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [
            {
              name: "CONFLICTING_NAME_ONE",
              class_name: "SomeDurableObject",
              script_name: "some-durable-object-worker",
            },
            {
              name: "CONFLICTING_NAME_TWO",
              class_name: "AnotherDurableObject",
              script_name: "another-durable-object-worker",
            },
          ],
        },
        kv_namespaces: [
          { binding: "CONFLICTING_NAME_ONE", id: "kv-ns-one-id" },
          { binding: "CONFLICTING_NAME_TWO", id: "kv-ns-two-id" },
        ],
        r2_buckets: [
          {
            binding: "CONFLICTING_NAME_ONE",
            bucket_name: "r2-bucket-one-name",
          },
          {
            binding: "CONFLICTING_NAME_THREE",
            bucket_name: "r2-bucket-two-name",
          },
        ],
        text_blobs: {
          CONFLICTING_NAME_THREE: "./my-entire-app-depends-on-this.cfg",
          CONFLICTING_NAME_FOUR: "./the-entirety-of-human-knowledge.txt",
        },
        unsafe: {
          bindings: [
            {
              name: "CONFLICTING_NAME_THREE",
              type: "some unsafe thing",
              data: { some: { unsafe: "thing" } },
            },
            {
              name: "CONFLICTING_NAME_FOUR",
              type: "another unsafe thing",
              data: 1337,
            },
          ],
        },
        vars: {
          ENV_VAR_ONE: 123,
          CONFLICTING_NAME_THREE: "Hello, I'm an environment variable",
        },
        wasm_modules: {
          WASM_MODULE_ONE: "./some_wasm.wasm",
          CONFLICTING_NAME_THREE: "./more_wasm.wasm",
        },
        data_blobs: {
          DATA_BLOB_ONE: "./some_data.bin",
          CONFLICTING_NAME_THREE: "./more_data.bin",
        },
      });

      writeWorkerSource({ type: "sw" });
      fs.writeFileSync("./my-entire-app-depends-on-this.cfg", "config = value");
      fs.writeFileSync(
        "./the-entirety-of-human-knowledge.txt",
        "Everything's bigger in Texas"
      );
      fs.writeFileSync("./some_wasm.wasm", "some wasm");
      fs.writeFileSync("./more_wasm.wasm", "more wasm");

      await expect(runWrangler("publish index.js")).rejects
        .toMatchInlineSnapshot(`
              [Error: Processing wrangler.toml configuration:
                - CONFLICTING_NAME_ONE assigned to Durable Object, KV Namespace, and R2 Bucket bindings.
                - CONFLICTING_NAME_TWO assigned to Durable Object and KV Namespace bindings.
                - CONFLICTING_NAME_THREE assigned to R2 Bucket, Text Blob, Unsafe, Environment Variable, WASM Module, and Data Blob bindings.
                - CONFLICTING_NAME_FOUR assigned to Text Blob and Unsafe bindings.
                - Bindings must have unique names, so that they can all be referenced in the worker.
                  Please change your bindings to have unique names.]
            `);
      expect(std.out).toMatchInlineSnapshot(`
        "
        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mProcessing wrangler.toml configuration:
          - CONFLICTING_NAME_ONE assigned to Durable Object, KV Namespace, and R2 Bucket bindings.
          - CONFLICTING_NAME_TWO assigned to Durable Object and KV Namespace bindings.
          - CONFLICTING_NAME_THREE assigned to R2 Bucket, Text Blob, Unsafe, Environment Variable, WASM Module, and Data Blob bindings.
          - CONFLICTING_NAME_FOUR assigned to Text Blob and Unsafe bindings.
          - Bindings must have unique names, so that they can all be referenced in the worker.
            Please change your bindings to have unique names.[0m

        "
      `);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
          - \\"unsafe\\" fields are experimental and may change or break at any time.[0m

        "
      `);
    });

    it("should error when bindings of the same type have the same name", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [
            {
              name: "CONFLICTING_DURABLE_OBJECT_NAME",
              class_name: "SomeDurableObject",
              script_name: "some-durable-object-worker",
            },
            {
              name: "CONFLICTING_DURABLE_OBJECT_NAME",
              class_name: "AnotherDurableObject",
              script_name: "another-durable-object-worker",
            },
          ],
        },
        kv_namespaces: [
          { binding: "CONFLICTING_KV_NAMESPACE_NAME", id: "kv-ns-one-id" },
          { binding: "CONFLICTING_KV_NAMESPACE_NAME", id: "kv-ns-two-id" },
        ],
        r2_buckets: [
          {
            binding: "CONFLICTING_R2_BUCKET_NAME",
            bucket_name: "r2-bucket-one-name",
          },
          {
            binding: "CONFLICTING_R2_BUCKET_NAME",
            bucket_name: "r2-bucket-two-name",
          },
        ],
        unsafe: {
          bindings: [
            {
              name: "CONFLICTING_UNSAFE_NAME",
              type: "some unsafe thing",
              data: { some: { unsafe: "thing" } },
            },
            {
              name: "CONFLICTING_UNSAFE_NAME",
              type: "another unsafe thing",
              data: 1337,
            },
          ],
        },
        // text_blobs, vars, wasm_modules and data_blobs are fine because they're object literals,
        // and by definition cannot have two keys of the same name
        //
        // text_blobs: {
        //   CONFLICTING_TEXT_BLOB_NAME: "./my-entire-app-depends-on-this.cfg",
        //   CONFLICTING_TEXT_BLOB_NAME: "./the-entirety-of-human-knowledge.txt",
        // },
        // vars: {
        //   CONFLICTING_VARS_NAME: 123,
        //   CONFLICTING_VARS_NAME: "Hello, I'm an environment variable",
        // },
        // wasm_modules: {
        //   CONFLICTING_WASM_MODULE_NAME: "./some_wasm.wasm",
        //   CONFLICTING_WASM_MODULE_NAME: "./more_wasm.wasm",
        // },
      });

      writeWorkerSource({ type: "sw" });

      await expect(runWrangler("publish index.js")).rejects
        .toMatchInlineSnapshot(`
              [Error: Processing wrangler.toml configuration:
                - CONFLICTING_DURABLE_OBJECT_NAME assigned to multiple Durable Object bindings.
                - CONFLICTING_KV_NAMESPACE_NAME assigned to multiple KV Namespace bindings.
                - CONFLICTING_R2_BUCKET_NAME assigned to multiple R2 Bucket bindings.
                - CONFLICTING_UNSAFE_NAME assigned to multiple Unsafe bindings.
                - Bindings must have unique names, so that they can all be referenced in the worker.
                  Please change your bindings to have unique names.]
            `);
      expect(std.out).toMatchInlineSnapshot(`
        "
        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mProcessing wrangler.toml configuration:
          - CONFLICTING_DURABLE_OBJECT_NAME assigned to multiple Durable Object bindings.
          - CONFLICTING_KV_NAMESPACE_NAME assigned to multiple KV Namespace bindings.
          - CONFLICTING_R2_BUCKET_NAME assigned to multiple R2 Bucket bindings.
          - CONFLICTING_UNSAFE_NAME assigned to multiple Unsafe bindings.
          - Bindings must have unique names, so that they can all be referenced in the worker.
            Please change your bindings to have unique names.[0m

        "
      `);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
          - \\"unsafe\\" fields are experimental and may change or break at any time.[0m

        "
      `);
    });

    it("should error correctly when bindings of the same and different types use the same name", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [
            {
              name: "CONFLICTING_DURABLE_OBJECT_NAME",
              class_name: "SomeDurableObject",
              script_name: "some-durable-object-worker",
            },
            {
              name: "CONFLICTING_DURABLE_OBJECT_NAME",
              class_name: "AnotherDurableObject",
              script_name: "another-durable-object-worker",
            },
          ],
        },
        kv_namespaces: [
          {
            binding: "CONFLICTING_KV_NAMESPACE_NAME",
            id: "kv-ns-one-id",
          },
          {
            binding: "CONFLICTING_KV_NAMESPACE_NAME",
            id: "kv-ns-two-id",
          },
          { binding: "CONFLICTING_NAME_ONE", id: "kv-ns-three-id" },
          { binding: "CONFLICTING_NAME_TWO", id: "kv-ns-four-id" },
        ],
        r2_buckets: [
          {
            binding: "CONFLICTING_R2_BUCKET_NAME",
            bucket_name: "r2-bucket-one-name",
          },
          {
            binding: "CONFLICTING_R2_BUCKET_NAME",
            bucket_name: "r2-bucket-two-name",
          },
          {
            binding: "CONFLICTING_NAME_THREE",
            bucket_name: "r2-bucket-three-name",
          },
          {
            binding: "CONFLICTING_NAME_FOUR",
            bucket_name: "r2-bucket-four-name",
          },
        ],
        text_blobs: {
          CONFLICTING_NAME_THREE: "./my-entire-app-depends-on-this.cfg",
          CONFLICTING_NAME_FOUR: "./the-entirety-of-human-knowledge.txt",
        },
        unsafe: {
          bindings: [
            {
              name: "CONFLICTING_UNSAFE_NAME",
              type: "some unsafe thing",
              data: { some: { unsafe: "thing" } },
            },
            {
              name: "CONFLICTING_UNSAFE_NAME",
              type: "another unsafe thing",
              data: 1337,
            },
            {
              name: "CONFLICTING_NAME_THREE",
              type: "yet another unsafe thing",
              data: "how is a string unsafe?",
            },
            {
              name: "CONFLICTING_NAME_FOUR",
              type: "a fourth unsafe thing",
              data: null,
            },
          ],
        },
        vars: {
          ENV_VAR_ONE: 123,
          CONFLICTING_NAME_THREE: "Hello, I'm an environment variable",
        },
        wasm_modules: {
          WASM_MODULE_ONE: "./some_wasm.wasm",
          CONFLICTING_NAME_THREE: "./more_wasm.wasm",
        },
        data_blobs: {
          DATA_BLOB_ONE: "./some_data.bin",
          CONFLICTING_NAME_THREE: "./more_data.bin",
        },
      });

      writeWorkerSource({ type: "sw" });
      fs.writeFileSync("./my-entire-app-depends-on-this.cfg", "config = value");
      fs.writeFileSync(
        "./the-entirety-of-human-knowledge.txt",
        "Everything's bigger in Texas"
      );
      fs.writeFileSync("./some_wasm.wasm", "some wasm");
      fs.writeFileSync("./more_wasm.wasm", "more wasm");

      await expect(runWrangler("publish index.js")).rejects
        .toMatchInlineSnapshot(`
              [Error: Processing wrangler.toml configuration:
                - CONFLICTING_DURABLE_OBJECT_NAME assigned to multiple Durable Object bindings.
                - CONFLICTING_KV_NAMESPACE_NAME assigned to multiple KV Namespace bindings.
                - CONFLICTING_R2_BUCKET_NAME assigned to multiple R2 Bucket bindings.
                - CONFLICTING_NAME_THREE assigned to R2 Bucket, Text Blob, Unsafe, Environment Variable, WASM Module, and Data Blob bindings.
                - CONFLICTING_NAME_FOUR assigned to R2 Bucket, Text Blob, and Unsafe bindings.
                - CONFLICTING_UNSAFE_NAME assigned to multiple Unsafe bindings.
                - Bindings must have unique names, so that they can all be referenced in the worker.
                  Please change your bindings to have unique names.]
            `);
      expect(std.out).toMatchInlineSnapshot(`
        "
        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mProcessing wrangler.toml configuration:
          - CONFLICTING_DURABLE_OBJECT_NAME assigned to multiple Durable Object bindings.
          - CONFLICTING_KV_NAMESPACE_NAME assigned to multiple KV Namespace bindings.
          - CONFLICTING_R2_BUCKET_NAME assigned to multiple R2 Bucket bindings.
          - CONFLICTING_NAME_THREE assigned to R2 Bucket, Text Blob, Unsafe, Environment Variable, WASM Module, and Data Blob bindings.
          - CONFLICTING_NAME_FOUR assigned to R2 Bucket, Text Blob, and Unsafe bindings.
          - CONFLICTING_UNSAFE_NAME assigned to multiple Unsafe bindings.
          - Bindings must have unique names, so that they can all be referenced in the worker.
            Please change your bindings to have unique names.[0m

        "
      `);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
          - \\"unsafe\\" fields are experimental and may change or break at any time.[0m

        "
      `);
    });

    describe("[wasm_modules]", () => {
      it("should be able to define wasm modules for service-worker format workers", async () => {
        writeWranglerToml({
          wasm_modules: {
            TESTWASMNAME: "./path/to/test.wasm",
          },
        });
        writeWorkerSource({ type: "sw" });
        fs.mkdirSync("./path/to", { recursive: true });
        fs.writeFileSync("./path/to/test.wasm", "SOME WASM CONTENT");
        mockUploadWorkerRequest({
          expectedType: "sw",
          expectedModules: { TESTWASMNAME: "SOME WASM CONTENT" },
          expectedBindings: [
            { name: "TESTWASMNAME", part: "TESTWASMNAME", type: "wasm_module" },
          ],
        });
        mockSubDomainRequest();
        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should error when defining wasm modules for modules format workers", async () => {
        writeWranglerToml({
          wasm_modules: {
            TESTWASMNAME: "./path/to/test.wasm",
          },
        });
        writeWorkerSource({ type: "esm" });
        fs.mkdirSync("./path/to", { recursive: true });
        fs.writeFileSync("./path/to/test.wasm", "SOME WASM CONTENT");

        await expect(
          runWrangler("publish index.js")
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"You cannot configure [wasm_modules] with an ES module worker. Instead, import the .wasm module directly in your code"`
        );
        expect(std.out).toMatchInlineSnapshot(`
          "
          [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
        `);
        expect(std.err).toMatchInlineSnapshot(`
          "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mYou cannot configure [wasm_modules] with an ES module worker. Instead, import the .wasm module directly in your code[0m

          "
        `);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should resolve wasm modules relative to the wrangler.toml file", async () => {
        fs.mkdirSync("./path/to/and/the/path/to/", { recursive: true });
        fs.writeFileSync(
          "./path/to/wrangler.toml",
          TOML.stringify({
            compatibility_date: "2022-01-12",
            name: "test-name",
            wasm_modules: {
              TESTWASMNAME: "./and/the/path/to/test.wasm",
            },
          }),

          "utf-8"
        );

        writeWorkerSource({ type: "sw" });
        fs.writeFileSync(
          "./path/to/and/the/path/to/test.wasm",
          "SOME WASM CONTENT"
        );
        mockUploadWorkerRequest({
          expectedType: "sw",
          expectedModules: { TESTWASMNAME: "SOME WASM CONTENT" },
          expectedBindings: [
            { name: "TESTWASMNAME", part: "TESTWASMNAME", type: "wasm_module" },
          ],
          expectedCompatibilityDate: "2022-01-12",
        });
        mockSubDomainRequest();
        await runWrangler("publish index.js --config ./path/to/wrangler.toml");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should be able to import .wasm modules from service-worker format workers", async () => {
        writeWranglerToml();
        fs.writeFileSync(
          "./index.js",
          "import TESTWASMNAME from './test.wasm';"
        );
        fs.writeFileSync("./test.wasm", "SOME WASM CONTENT");
        mockUploadWorkerRequest({
          expectedType: "sw",
          expectedModules: {
            __94b240d0d692281e6467aa42043986e5c7eea034_test_wasm:
              "SOME WASM CONTENT",
          },
          expectedBindings: [
            {
              name: "__94b240d0d692281e6467aa42043986e5c7eea034_test_wasm",
              part: "__94b240d0d692281e6467aa42043986e5c7eea034_test_wasm",
              type: "wasm_module",
            },
          ],
        });
        mockSubDomainRequest();
        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    });

    describe("[text_blobs]", () => {
      it("should be able to define text blobs for service-worker format workers", async () => {
        writeWranglerToml({
          text_blobs: {
            TESTTEXTBLOBNAME: "./path/to/text.file",
          },
        });
        writeWorkerSource({ type: "sw" });
        fs.mkdirSync("./path/to", { recursive: true });
        fs.writeFileSync("./path/to/text.file", "SOME TEXT CONTENT");
        mockUploadWorkerRequest({
          expectedType: "sw",
          expectedModules: { TESTTEXTBLOBNAME: "SOME TEXT CONTENT" },
          expectedBindings: [
            {
              name: "TESTTEXTBLOBNAME",
              part: "TESTTEXTBLOBNAME",
              type: "text_blob",
            },
          ],
        });
        mockSubDomainRequest();
        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should error when defining text blobs for modules format workers", async () => {
        writeWranglerToml({
          text_blobs: {
            TESTTEXTBLOBNAME: "./path/to/text.file",
          },
        });
        writeWorkerSource({ type: "esm" });
        fs.mkdirSync("./path/to", { recursive: true });
        fs.writeFileSync("./path/to/text.file", "SOME TEXT CONTENT");

        await expect(
          runWrangler("publish index.js")
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"You cannot configure [text_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure \`[rules]\` in your wrangler.toml"`
        );
        expect(std.out).toMatchInlineSnapshot(`
          "
          [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
        `);
        expect(std.err).toMatchInlineSnapshot(`
          "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mYou cannot configure [text_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure \`[rules]\` in your wrangler.toml[0m

          "
        `);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should resolve text blobs relative to the wrangler.toml file", async () => {
        fs.mkdirSync("./path/to/and/the/path/to/", { recursive: true });
        fs.writeFileSync(
          "./path/to/wrangler.toml",
          TOML.stringify({
            compatibility_date: "2022-01-12",
            name: "test-name",
            text_blobs: {
              TESTTEXTBLOBNAME: "./and/the/path/to/text.file",
            },
          }),

          "utf-8"
        );

        writeWorkerSource({ type: "sw" });
        fs.writeFileSync(
          "./path/to/and/the/path/to/text.file",
          "SOME TEXT CONTENT"
        );
        mockUploadWorkerRequest({
          expectedType: "sw",
          expectedModules: { TESTTEXTBLOBNAME: "SOME TEXT CONTENT" },
          expectedBindings: [
            {
              name: "TESTTEXTBLOBNAME",
              part: "TESTTEXTBLOBNAME",
              type: "text_blob",
            },
          ],
          expectedCompatibilityDate: "2022-01-12",
        });
        mockSubDomainRequest();
        await runWrangler("publish index.js --config ./path/to/wrangler.toml");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    });

    describe("[data_blobs]", () => {
      it("should be able to define data blobs for service-worker format workers", async () => {
        writeWranglerToml({
          data_blobs: {
            TESTDATABLOBNAME: "./path/to/data.bin",
          },
        });
        writeWorkerSource({ type: "sw" });
        fs.mkdirSync("./path/to", { recursive: true });
        fs.writeFileSync("./path/to/data.bin", "SOME DATA CONTENT");
        mockUploadWorkerRequest({
          expectedType: "sw",
          expectedModules: { TESTDATABLOBNAME: "SOME DATA CONTENT" },
          expectedBindings: [
            {
              name: "TESTDATABLOBNAME",
              part: "TESTDATABLOBNAME",
              type: "data_blob",
            },
          ],
        });
        mockSubDomainRequest();
        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should error when defining data blobs for modules format workers", async () => {
        writeWranglerToml({
          data_blobs: {
            TESTDATABLOBNAME: "./path/to/data.bin",
          },
        });
        writeWorkerSource({ type: "esm" });
        fs.mkdirSync("./path/to", { recursive: true });
        fs.writeFileSync("./path/to/data.bin", "SOME DATA CONTENT");

        await expect(
          runWrangler("publish index.js")
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `"You cannot configure [data_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure \`[rules]\` in your wrangler.toml"`
        );
        expect(std.out).toMatchInlineSnapshot(`
          "
          [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new.[0m"
        `);
        expect(std.err).toMatchInlineSnapshot(`
          "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mYou cannot configure [data_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure \`[rules]\` in your wrangler.toml[0m

          "
        `);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should resolve data blobs relative to the wrangler.toml file", async () => {
        fs.mkdirSync("./path/to/and/the/path/to/", { recursive: true });
        fs.writeFileSync(
          "./path/to/wrangler.toml",
          TOML.stringify({
            compatibility_date: "2022-01-12",
            name: "test-name",
            data_blobs: {
              TESTDATABLOBNAME: "./and/the/path/to/data.bin",
            },
          }),

          "utf-8"
        );

        writeWorkerSource({ type: "sw" });
        fs.writeFileSync(
          "./path/to/and/the/path/to/data.bin",
          "SOME DATA CONTENT"
        );
        mockUploadWorkerRequest({
          expectedType: "sw",
          expectedModules: { TESTDATABLOBNAME: "SOME DATA CONTENT" },
          expectedBindings: [
            {
              name: "TESTDATABLOBNAME",
              part: "TESTDATABLOBNAME",
              type: "data_blob",
            },
          ],
          expectedCompatibilityDate: "2022-01-12",
        });
        mockSubDomainRequest();
        await runWrangler("publish index.js --config ./path/to/wrangler.toml");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    });

    describe("[vars]", () => {
      it("should support json bindings", async () => {
        writeWranglerToml({
          vars: {
            text: "plain ol' string",
            count: 1,
            complex: { enabled: true, id: 123 },
          },
        });
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          expectedBindings: [
            { name: "text", type: "plain_text", text: "plain ol' string" },
            { name: "count", type: "json", json: 1 },
            {
              name: "complex",
              type: "json",
              json: { enabled: true, id: 123 },
            },
          ],
        });

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    });

    describe("[r2_buckets]", () => {
      it("should support r2 bucket bindings", async () => {
        writeWranglerToml({
          r2_buckets: [{ binding: "FOO", bucket_name: "foo-bucket" }],
        });
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          expectedBindings: [
            { bucket_name: "foo-bucket", name: "FOO", type: "r2_bucket" },
          ],
        });

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    });

    describe("[durable_objects]", () => {
      it("should support durable object bindings", async () => {
        writeWranglerToml({
          durable_objects: {
            bindings: [
              {
                name: "EXAMPLE_DO_BINDING",
                class_name: "ExampleDurableObject",
              },
            ],
          },
          migrations: [{ tag: "v1", new_classes: ["ExampleDurableObject"] }],
        });
        fs.writeFileSync(
          "index.js",
          `export class ExampleDurableObject {}; export default{};`
        );
        mockSubDomainRequest();
        mockLegacyScriptData({
          scripts: [{ id: "test-name", migration_tag: "v1" }],
        });
        mockUploadWorkerRequest({
          expectedBindings: [
            {
              class_name: "ExampleDurableObject",
              name: "EXAMPLE_DO_BINDING",
              type: "durable_object_namespace",
            },
          ],
        });

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should support service-workers binding to external durable objects", async () => {
        writeWranglerToml({
          durable_objects: {
            bindings: [
              {
                name: "EXAMPLE_DO_BINDING",
                class_name: "ExampleDurableObject",
                script_name: "example-do-binding-worker",
              },
            ],
          },
        });
        writeWorkerSource({ type: "sw" });
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          expectedType: "sw",
          expectedBindings: [
            {
              name: "EXAMPLE_DO_BINDING",
              class_name: "ExampleDurableObject",
              script_name: "example-do-binding-worker",
              type: "durable_object_namespace",
            },
          ],
        });

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should support module workers implementing durable objects", async () => {
        writeWranglerToml({
          durable_objects: {
            bindings: [
              {
                name: "EXAMPLE_DO_BINDING",
                class_name: "ExampleDurableObject",
              },
            ],
          },
          migrations: [{ tag: "v1", new_classes: ["ExampleDurableObject"] }],
        });
        fs.writeFileSync(
          "index.js",
          `export class ExampleDurableObject {}; export default{};`
        );
        mockSubDomainRequest();
        mockLegacyScriptData({
          scripts: [{ id: "test-name", migration_tag: "v1" }],
        });
        mockUploadWorkerRequest({
          expectedType: "esm",
          expectedBindings: [
            {
              name: "EXAMPLE_DO_BINDING",
              class_name: "ExampleDurableObject",
              type: "durable_object_namespace",
            },
          ],
        });

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });

      it("should error when detecting a service-worker worker implementing durable objects", async () => {
        writeWranglerToml({
          durable_objects: {
            bindings: [
              {
                name: "EXAMPLE_DO_BINDING",
                class_name: "ExampleDurableObject",
              },
            ],
          },
        });
        writeWorkerSource({ type: "sw" });
        mockSubDomainRequest();

        await expect(runWrangler("publish index.js")).rejects
          .toThrowErrorMatchingInlineSnapshot(`
                              "You seem to be trying to use Durable Objects in a Worker written as a service-worker.
                              You can use Durable Objects defined in other Workers by specifying a \`script_name\` in your wrangler.toml, where \`script_name\` is the name of the Worker that implements that Durable Object. For example:
                              { name = EXAMPLE_DO_BINDING, class_name = ExampleDurableObject } ==> { name = EXAMPLE_DO_BINDING, class_name = ExampleDurableObject, script_name = example-do-binding-worker }
                              Alternatively, migrate your worker to ES Module syntax to implement a Durable Object in this Worker:
                              https://developers.cloudflare.com/workers/learning/migrating-to-module-workers/"
                          `);
      });
    });

    describe("[unsafe]", () => {
      it("should warn if using unsafe bindings", async () => {
        writeWranglerToml({
          unsafe: {
            bindings: [
              {
                name: "my-binding",
                type: "binding-type",
                param: "binding-param",
              },
            ],
          },
        });
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          expectedBindings: [
            {
              name: "my-binding",
              type: "binding-type",
              param: "binding-param",
            },
          ],
        });

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`
          "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
            - \\"unsafe\\" fields are experimental and may change or break at any time.[0m

          "
        `);
      });
      it("should warn if using unsafe bindings already handled by wrangler", async () => {
        writeWranglerToml({
          unsafe: {
            bindings: [
              {
                name: "my-binding",
                type: "plain_text",
                text: "text",
              },
            ],
          },
        });
        writeWorkerSource();
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          expectedBindings: [
            {
              name: "my-binding",
              type: "plain_text",
              text: "text",
            },
          ],
        });

        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
                  "Uploaded test-name (TIMINGS)
                  Published test-name (TIMINGS)
                    test-name.test-sub-domain.workers.dev"
              `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`
          "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
            - \\"unsafe\\" fields are experimental and may change or break at any time.
            - \\"unsafe.bindings[0]\\": {\\"name\\":\\"my-binding\\",\\"type\\":\\"plain_text\\",\\"text\\":\\"text\\"}
              - The binding type \\"plain_text\\" is directly supported by wrangler.
                Consider migrating this unsafe binding to a format for 'plain_text' bindings that is supported by wrangler for optimal support.
                For more details, see https://developers.cloudflare.com/workers/cli-wrangler/configuration[0m

          "
        `);
      });
    });
  });

  describe("upload rules", () => {
    it("should be able to define rules for uploading non-js modules (sw)", async () => {
      writeWranglerToml({
        rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: true }],
      });
      fs.writeFileSync("./index.js", `import TEXT from './text.file';`);
      fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedType: "sw",
        expectedBindings: [
          {
            name: "__2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0_text_file",
            part: "__2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0_text_file",
            type: "text_blob",
          },
        ],
        expectedModules: {
          __2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0_text_file:
            "SOME TEXT CONTENT",
        },
      });
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should be able to define rules for uploading non-js modules (esm)", async () => {
      writeWranglerToml({
        rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: true }],
      });
      fs.writeFileSync(
        "./index.js",
        `import TEXT from './text.file'; export default {};`
      );
      fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedType: "esm",
        expectedBindings: [],
        expectedModules: {
          "./2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0-text.file":
            "SOME TEXT CONTENT",
        },
      });
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should log a deprecation warning when using `build.upload.rules`", async () => {
      writeWranglerToml({
        build: {
          upload: {
            rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: true }],
          },
        },
      });
      fs.writeFileSync(
        "./index.js",
        `import TEXT from './text.file'; export default {};`
      );
      fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedType: "esm",
        expectedBindings: [],
        expectedModules: {
          "./2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0-text.file":
            "SOME TEXT CONTENT",
        },
      });
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:
          - DEPRECATION: The \`build.upload.rules\` config field is no longer used, the rules should be specified via the \`rules\` config field. Delete the \`build.upload\` field from the configuration file, and add this:
            \`\`\`
            [[rules]]
            type = \\"Text\\"
            globs = [ \\"**/*.file\\" ]
            fallthrough = true
            \`\`\`[0m

        "
      `);
    });

    it("should be able to use fallthrough:true for multiple rules", async () => {
      writeWranglerToml({
        rules: [
          { type: "Text", globs: ["**/*.file"], fallthrough: true },
          { type: "Text", globs: ["**/*.other"], fallthrough: true },
        ],
      });
      fs.writeFileSync(
        "./index.js",
        `import TEXT from './text.file'; import OTHER from './other.other'; export default {};`
      );
      fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
      fs.writeFileSync("./other.other", "SOME OTHER TEXT CONTENT");
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedType: "esm",
        expectedBindings: [],
        expectedModules: {
          "./2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0-text.file":
            "SOME TEXT CONTENT",
          "./16347a01366873ed80fe45115119de3c92ab8db0-other.other":
            "SOME OTHER TEXT CONTENT",
        },
      });
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    it("should be able to use fallthrough:false for multiple rules", async () => {
      writeWranglerToml({
        rules: [
          { type: "Text", globs: ["**/*.file"], fallthrough: false },
          { type: "Text", globs: ["**/*.other"] },
        ],
      });
      fs.writeFileSync(
        "./index.js",
        `import TEXT from './text.file'; import OTHER from './other.other'; export default {};`
      );
      fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
      fs.writeFileSync("./other.other", "SOME OTHER TEXT CONTENT");

      // We throw an error when we come across a file that matched a rule
      // but was skipped because of fallthrough = false
      let err: Error | undefined;
      try {
        await runWrangler("publish index.js");
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(
        `The file ./other.other matched a module rule in your configuration ({"type":"Text","globs":["**/*.other"]}), but was ignored because a previous rule with the same type was not marked as \`fallthrough = true\`.`
      );
    });

    it("should warn when multiple rules for the same type do not have fallback defined", async () => {
      writeWranglerToml({
        rules: [
          { type: "Text", globs: ["**/*.file"] },
          { type: "Text", globs: ["**/*.other"] },
        ],
      });
      fs.writeFileSync(
        "./index.js",
        `import TEXT from './text.file'; import OTHER from './other.other'; export default {};`
      );
      fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
      fs.writeFileSync("./other.other", "SOME OTHER TEXT CONTENT");

      // We throw an error when we come across a file that matched a rule
      // but was skipped because of fallthrough = false
      let err: Error | undefined;
      try {
        await runWrangler("publish index.js");
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(
        `The file ./other.other matched a module rule in your configuration ({"type":"Text","globs":["**/*.other"]}), but was ignored because a previous rule with the same type was not marked as \`fallthrough = true\`.`
      );
      // and the warnings because fallthrough was not explicitly set
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mThe module rule at position 1 ({\\"type\\":\\"Text\\",\\"globs\\":[\\"**/*.other\\"]}) has the same type as a previous rule (at position 0, {\\"type\\":\\"Text\\",\\"globs\\":[\\"**/*.file\\"]}). This rule will be ignored. To the previous rule, add \`fallthrough = true\` to allow this one to also be used, or \`fallthrough = false\` to silence this warning.[0m


        [33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mThe default module rule {\\"type\\":\\"Text\\",\\"globs\\":[\\"**/*.txt\\",\\"**/*.html\\"]} has the same type as a previous rule (at position 0, {\\"type\\":\\"Text\\",\\"globs\\":[\\"**/*.file\\"]}). This rule will be ignored. To the previous rule, add \`fallthrough = true\` to allow the default one to also be used, or \`fallthrough = false\` to silence this warning.[0m

        "
      `);
    });

    describe("inject process.env.NODE_ENV", () => {
      let actualProcessEnvNodeEnv: string | undefined;
      beforeEach(() => {
        actualProcessEnvNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "some-node-env";
      });
      afterEach(() => {
        process.env.NODE_ENV = actualProcessEnvNodeEnv;
      });
      it("should replace `process.env.NODE_ENV` in scripts", async () => {
        writeWranglerToml();
        fs.writeFileSync(
          "./index.js",
          `export default {
            fetch(){
              return new Response(process.env.NODE_ENV);
            }
          }`
        );
        mockSubDomainRequest();
        mockUploadWorkerRequest({
          expectedEntry: `return new Response("some-node-env");`,
        });
        await runWrangler("publish index.js");
        expect(std.out).toMatchInlineSnapshot(`
          "Uploaded test-name (TIMINGS)
          Published test-name (TIMINGS)
            test-name.test-sub-domain.workers.dev"
        `);
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    });
  });

  describe("legacy module specifiers", () => {
    it("should work with legacy module specifiers, with a deprecation warning (1)", async () => {
      writeWranglerToml({
        rules: [{ type: "Text", globs: ["**/*.file"], fallthrough: false }],
      });
      fs.writeFileSync(
        "./index.js",
        `import TEXT from 'text.file'; export default {};`
      );
      fs.writeFileSync("./text.file", "SOME TEXT CONTENT");
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedModules: {
          "./2d91d1c4dd6e57d4f5432187ab7c25f45a8973f0-text.file":
            "SOME TEXT CONTENT",
        },
      });
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mDEPRECATION: detected a legacy module import in \\"./index.js\\". This will stop working in the future. Replace references to \\"text.file\\" with \\"./text.file\\";[0m

        "
      `);
    });

    it("should work with legacy module specifiers, with a deprecation warning (2)", async () => {
      writeWranglerToml();
      fs.writeFileSync(
        "./index.js",
        `import WASM from 'index.wasm'; export default {};`
      );
      fs.writeFileSync("./index.wasm", "SOME WASM CONTENT");
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedModules: {
          "./94b240d0d692281e6467aa42043986e5c7eea034-index.wasm":
            "SOME WASM CONTENT",
        },
      });
      await runWrangler("publish index.js");
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mDEPRECATION: detected a legacy module import in \\"./index.js\\". This will stop working in the future. Replace references to \\"index.wasm\\" with \\"./index.wasm\\";[0m

        "
      `);
    });

    it("should not match regular module specifiers when there aren't any possible legacy module matches", async () => {
      // see https://github.com/cloudflare/wrangler2/issues/655 for bug details

      fs.writeFileSync(
        "./index.js",
        `import inner from './inner/index.js'; export default {};`
      );
      fs.mkdirSync("./inner", { recursive: true });
      fs.writeFileSync("./inner/index.js", `export default 123`);
      mockSubDomainRequest();
      mockUploadWorkerRequest();

      await runWrangler(
        "publish index.js --compatibility-date 2022-03-17 --name test-name"
      );
      expect(std.out).toMatchInlineSnapshot(`
        "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev"
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });
  });

  describe("tsconfig", () => {
    it("should use compilerOptions.paths to resolve modules", async () => {
      writeWranglerToml({
        main: "index.ts",
      });
      fs.writeFileSync(
        "index.ts",
        `import { foo } from '~lib/foo'; export default { fetch() { return new Response(foo)} }`
      );
      fs.mkdirSync("lib", { recursive: true });
      fs.writeFileSync("lib/foo.ts", `export const foo = 123;`);
      fs.writeFileSync(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "~lib/*": ["lib/*"],
            },
          },
        })
      );
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedEntry: "var foo = 123;", // make sure it imported the module correctly
      });
      await runWrangler("publish index.ts");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev",
          "warn": "",
        }
      `);
    });

    it("should output to target es2020 even if tsconfig says otherwise", async () => {
      writeWranglerToml();
      writeWorkerSource();
      fs.writeFileSync(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            target: "es5",
            module: "commonjs",
          },
        })
      );
      mockSubDomainRequest();
      mockUploadWorkerRequest({
        expectedEntry: "export {", // just check that the export is preserved
      });
      await runWrangler("publish index.js"); // this would throw if we tried to compile with es5
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev",
          "warn": "",
        }
      `);
    });
  });

  describe("--outdir", () => {
    it("should generate built assets at --outdir if specified", async () => {
      writeWranglerToml();
      writeWorkerSource();
      mockSubDomainRequest();
      mockUploadWorkerRequest();
      await runWrangler("publish index.js --outdir some-dir");
      expect(fs.existsSync("some-dir/index.js")).toBe(true);
      expect(fs.existsSync("some-dir/index.js.map")).toBe(true);
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Uploaded test-name (TIMINGS)
        Published test-name (TIMINGS)
          test-name.test-sub-domain.workers.dev",
          "warn": "",
        }
      `);
    });
  });

  describe("--dry-run", () => {
    it("should not publish the worker if --dry-run is specified", async () => {
      writeWranglerToml();
      writeWorkerSource();
      await runWrangler("publish index.js --dry-run");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "--dry-run: exiting now.",
          "warn": "",
        }
      `);
    });
  });

  describe("--node-compat", () => {
    it("should warn when using node compatibility mode", async () => {
      writeWranglerToml();
      writeWorkerSource();
      await runWrangler("publish index.js --node-compat --dry-run");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "--dry-run: exiting now.",
          "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mEnabling node.js compatibility mode for builtins and globals. This is experimental and has serious tradeoffs. Please see https://github.com/ionic-team/rollup-plugin-node-polyfills/ for more details.[0m

        ",
        }
      `);
    });

    it("should polyfill node builtins when enabled", async () => {
      writeWranglerToml();
      fs.writeFileSync(
        "index.js",
        `
      import path from 'path';
      console.log(path.join("some/path/to", "a/file.txt"));
      export default {}
      `
      );
      await runWrangler("publish index.js --node-compat --dry-run"); // this would throw if node compatibility didn't exist
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "--dry-run: exiting now.",
          "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mEnabling node.js compatibility mode for builtins and globals. This is experimental and has serious tradeoffs. Please see https://github.com/ionic-team/rollup-plugin-node-polyfills/ for more details.[0m

        ",
        }
      `);
    });
  });
});

/** Write mock assets to the file system so they can be uploaded. */
function writeAssets(assets: { filePath: string; content: string }[]) {
  for (const asset of assets) {
    fs.mkdirSync(path.dirname(asset.filePath), { recursive: true });
    fs.writeFileSync(asset.filePath, asset.content);
  }
}

/** Create a mock handler for the request to upload a worker script. */
function mockUploadWorkerRequest(
  options: {
    available_on_subdomain?: boolean;
    expectedEntry?: string;
    expectedType?: "esm" | "sw";
    expectedBindings?: unknown;
    expectedModules?: Record<string, string>;
    expectedCompatibilityDate?: string;
    expectedCompatibilityFlags?: string[];
    expectedMigrations?: CfWorkerInit["migrations"];
    env?: string;
    legacyEnv?: boolean;
  } = {}
) {
  const {
    available_on_subdomain = true,
    expectedEntry,
    expectedType = "esm",
    expectedBindings,
    expectedModules = {},
    expectedCompatibilityDate,
    expectedCompatibilityFlags,
    env = undefined,
    legacyEnv = false,
    expectedMigrations,
  } = options;
  setMockResponse(
    env && !legacyEnv
      ? "/accounts/:accountId/workers/services/:scriptName/environments/:envName"
      : "/accounts/:accountId/workers/scripts/:scriptName",
    "PUT",
    async ([_url, accountId, scriptName, envName], { body }, queryParams) => {
      expect(accountId).toEqual("some-account-id");
      expect(scriptName).toEqual(
        legacyEnv && env ? `test-name-${env}` : "test-name"
      );
      if (!legacyEnv) {
        expect(envName).toEqual(env);
      }
      expect(queryParams.get("include_subdomain_availability")).toEqual("true");
      const formBody = body as FormData;
      if (expectedEntry !== undefined) {
        expect(await (formBody.get("index.js") as File).text()).toMatch(
          expectedEntry
        );
      }
      const metadata = JSON.parse(
        formBody.get("metadata") as string
      ) as WorkerMetadata;
      if (expectedType === "esm") {
        expect(metadata.main_module).toEqual("index.js");
      } else {
        expect(metadata.body_part).toEqual("index.js");
      }
      if ("expectedBindings" in options) {
        expect(metadata.bindings).toEqual(expectedBindings);
      }
      if ("expectedCompatibilityDate" in options) {
        expect(metadata.compatibility_date).toEqual(expectedCompatibilityDate);
      }
      if ("expectedCompatibilityFlags" in options) {
        expect(metadata.compatibility_flags).toEqual(
          expectedCompatibilityFlags
        );
      }
      if ("expectedMigrations" in options) {
        expect(metadata.migrations).toEqual(expectedMigrations);
      }
      for (const [name, content] of Object.entries(expectedModules)) {
        expect(await (formBody.get(name) as File).text()).toEqual(content);
      }

      return { available_on_subdomain };
    }
  );
}

/** Create a mock handler for the request to get the account's subdomain. */
function mockSubDomainRequest(
  subdomain = "test-sub-domain",
  registeredWorkersDev = true
) {
  if (registeredWorkersDev) {
    setMockResponse("/accounts/:accountId/workers/subdomain", "GET", () => {
      return { subdomain };
    });
  } else {
    setMockRawResponse("/accounts/:accountId/workers/subdomain", "GET", () => {
      return createFetchResult(null, false, [
        { code: 10007, message: "haven't registered workers.dev" },
      ]);
    });
  }
}

/** Create a mock handler to toggle a <script>.<user>.workers.dev subdomain */
function mockUpdateWorkerRequest({
  env,
  enabled,
  legacyEnv = false,
}: {
  enabled: boolean;
  env?: string | undefined;
  legacyEnv?: boolean | undefined;
}) {
  const requests = { count: 0 };
  const servicesOrScripts = env && !legacyEnv ? "services" : "scripts";
  const environment = env && !legacyEnv ? "/environments/:envName" : "";
  setMockResponse(
    `/accounts/:accountId/workers/${servicesOrScripts}/:scriptName${environment}/subdomain`,
    "POST",
    ([_url, accountId, scriptName, envName], { body }) => {
      expect(accountId).toEqual("some-account-id");
      expect(scriptName).toEqual(
        legacyEnv && env ? `test-name-${env}` : "test-name"
      );
      if (!legacyEnv) {
        expect(envName).toEqual(env);
      }
      expect(JSON.parse(body as string)).toEqual({ enabled });
      return null;
    }
  );
  return requests;
}

function mockPublishRoutesRequest({
  routes = [],
  env = undefined,
  legacyEnv = false,
}: {
  routes: Config["routes"];
  env?: string | undefined;
  legacyEnv?: boolean | undefined;
}) {
  const servicesOrScripts = env && !legacyEnv ? "services" : "scripts";
  const environment = env && !legacyEnv ? "/environments/:envName" : "";

  setMockResponse(
    `/accounts/:accountId/workers/${servicesOrScripts}/:scriptName${environment}/routes`,
    "PUT",
    ([_url, accountId, scriptName, envName], { body }) => {
      expect(accountId).toEqual("some-account-id");
      expect(scriptName).toEqual(
        legacyEnv && env ? `test-name-${env}` : "test-name"
      );
      if (!legacyEnv) {
        expect(envName).toEqual(env);
      }

      expect(JSON.parse(body as string)).toEqual(
        routes.map((route) =>
          typeof route !== "object" ? { pattern: route } : route
        )
      );
      return null;
    }
  );
}

/** Create a mock handler for the request to get a list of all KV namespaces. */
function mockListKVNamespacesRequest(...namespaces: KVNamespaceInfo[]) {
  setMockResponse(
    "/accounts/:accountId/storage/kv/namespaces",
    "GET",
    ([_url, accountId]) => {
      expect(accountId).toEqual("some-account-id");
      return namespaces;
    }
  );
}

/** Create a mock handler for the request that tries to do a bulk upload of assets to a KV namespace. */
function mockUploadAssetsToKVRequest(
  expectedNamespaceId: string,
  assets: {
    filePath: string;
    content: string;
    expiration?: number;
    expiration_ttl?: number;
  }[]
) {
  setMockResponse(
    "/accounts/:accountId/storage/kv/namespaces/:namespaceId/bulk",
    "PUT",
    ([_url, accountId, namespaceId], { body }) => {
      expect(accountId).toEqual("some-account-id");
      expect(namespaceId).toEqual(expectedNamespaceId);
      const uploads = JSON.parse(body as string);
      expect(assets.length).toEqual(uploads.length);
      for (let i = 0; i < uploads.length; i++) {
        const asset = assets[i];
        const upload = uploads[i];
        // The asset key consists of:
        // - the basename of the filepath
        // - some hash value
        // - the extension
        const keyMatcher = new RegExp(
          "^" +
            asset.filePath
              .replace(/(\.[^.]+)$/, ".[a-z0-9]+$1")
              .replace(/\./g, "\\.")
        );
        expect(upload.key).toMatch(keyMatcher);
        // The asset value is base64 encoded.
        expect(upload.base64).toBe(true);
        expect(Buffer.from(upload.value, "base64").toString()).toEqual(
          asset.content
        );
        expect(upload.expiration).toEqual(asset.expiration);
        expect(upload.expiration_ttl).toEqual(asset.expiration_ttl);
      }
      return null;
    }
  );
}

/** Create a mock handler for thr request that does a bulk delete of unused assets */
function mockDeleteUnusedAssetsRequest(
  expectedNamespaceId: string,
  assets: string[]
) {
  setMockResponse(
    "/accounts/:accountId/storage/kv/namespaces/:namespaceId/bulk",
    "DELETE",
    ([_url, accountId, namespaceId], { body }) => {
      expect(accountId).toEqual("some-account-id");
      expect(namespaceId).toEqual(expectedNamespaceId);
      const deletes = JSON.parse(body as string);
      expect(assets).toEqual(deletes);
      return null;
    }
  );
}

type LegacyScriptInfo = { id: string; migration_tag?: string };

function mockLegacyScriptData(options: { scripts: LegacyScriptInfo[] }) {
  const { scripts } = options;
  setMockResponse(
    "/accounts/:accountId/workers/scripts",
    "GET",
    ([_url, accountId]) => {
      expect(accountId).toEqual("some-account-id");
      return scripts;
    }
  );
}

type DurableScriptInfo = { id: string; migration_tag?: string };

function mockServiceScriptData(options: {
  script?: DurableScriptInfo;
  scriptName?: string;
  env?: string;
}) {
  const { script } = options;
  if (options.env) {
    if (!script) {
      setMockRawResponse(
        "/accounts/:accountId/workers/services/:scriptName/environments/:envName",
        "GET",
        () => {
          return createFetchResult(null, false, [
            { code: 10092, message: "workers.api.error.environment_not_found" },
          ]);
        }
      );
      return;
    }
    setMockResponse(
      "/accounts/:accountId/workers/services/:scriptName/environments/:envName",
      "GET",
      ([_url, accountId, scriptName, envName]) => {
        expect(accountId).toEqual("some-account-id");
        expect(scriptName).toEqual(options.scriptName || "test-name");
        expect(envName).toEqual(options.env);
        return { script };
      }
    );
  } else {
    if (!script) {
      setMockRawResponse(
        "/accounts/:accountId/workers/services/:scriptName",
        "GET",
        () => {
          return createFetchResult(null, false, [
            { code: 10090, message: "workers.api.error.service_not_found" },
          ]);
        }
      );
      return;
    }
    setMockResponse(
      "/accounts/:accountId/workers/services/:scriptName",
      "GET",
      ([_url, accountId, scriptName]) => {
        expect(accountId).toEqual("some-account-id");
        expect(scriptName).toEqual(options.scriptName || "test-name");
        return { default_environment: { script } };
      }
    );
  }
}
