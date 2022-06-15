import * as fs from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import TOML from "@iarna/toml";
import chalk from "chalk";
import { findUp } from "find-up";
import getPort from "get-port";
import { render } from "ink";
import React from "react";
import onExit from "signal-exit";
import supportsColor from "supports-color";
import makeCLI, { command } from "yargs";
import { version as wranglerVersion } from "../package.json";
import { fetchResult } from "./cfetch";
import { findWranglerToml, readConfig } from "./config";
import { createWorkerUploadForm } from "./create-worker-upload-form";
import Dev from "./dev/dev";
import { confirm, prompt } from "./dialogs";
import { getEntry } from "./entry";
import { DeprecationError } from "./errors";
import {
  getNamespaceId,
  listNamespaces,
  listNamespaceKeys,
  putKeyValue,
  putBulkKeyValue,
  deleteBulkKeyValue,
  createNamespace,
  isValidNamespaceBinding,
  getKeyValue,
  isKeyValue,
  unexpectedKeyValueProps,
} from "./kv";
import { logger } from "./logger";
import { getPackageManager } from "./package-manager";
import { pages, pagesBetaWarning } from "./pages";
import {
  formatMessage,
  ParseError,
  parseJSON,
  parseTOML,
  parseHumanDuration,
  readFileSync,
} from "./parse";
import publish from "./publish";
import { createR2Bucket, deleteR2Bucket, listR2Buckets } from "./r2";
import * as pubsub from "./pubsub";
import { getAssetPaths } from "./sites";
import {
  createTail,
  jsonPrintLogs,
  prettyPrintLogs,
  translateCLICommandToFilterMessage,
} from "./tail";
import { updateCheck } from "./update-check";
import {
  login,
  logout,
  listScopes,
  validateScopeKeys,
  requireAuth,
} from "./user";
import { whoami } from "./whoami";

import type { Config } from "./config";
import type { TailCLIFilters } from "./tail";
import type { RawData } from "ws";
import type { CommandModule } from "yargs";
import type Yargs from "yargs";

type ConfigPath = string | undefined;

const resetColor = "\x1b[0m";
const fgGreenColor = "\x1b[32m";

function getRules(config: Config): Config["rules"] {
  const rules = config.rules ?? config.build?.upload?.rules ?? [];

  if (config.rules && config.build?.upload?.rules) {
    throw new Error(
      `You cannot configure both [rules] and [build.upload.rules] in your wrangler.toml. Delete the \`build.upload\` section.`
    );
  }

  if (config.build?.upload?.rules) {
    logger.warn(
      `DEPRECATION: The \`build.upload.rules\` config field is no longer used, the rules should be specified via the \`rules\` config field. Delete the \`build.upload\` field from the configuration file, and add this:

${TOML.stringify({ rules: config.build.upload.rules })}`
    );
  }
  return rules;
}

async function printWranglerBanner() {
  // Let's not print this in tests
  if (typeof jest !== "undefined") {
    return;
  }

  const text = ` ⛅️ wrangler ${wranglerVersion} ${await updateCheck()}`;

  logger.log(
    text +
      "\n" +
      (supportsColor.stdout
        ? chalk.hex("#FF8800")("-".repeat(text.length))
        : "-".repeat(text.length))
  );
}

function isLegacyEnv(config: Config): boolean {
  // We only read from config here, because we've already accounted for
  // args["legacy-env"] in https://github.com/cloudflare/wrangler2/blob/b24aeb5722370c2e04bce97a84a1fa1e55725d79/packages/wrangler/src/config/validation.ts#L94-L98
  return config.legacy_env;
}

function getScriptName(
  args: { name: string | undefined; env: string | undefined },
  config: Config
): string | undefined {
  if (args.name && isLegacyEnv(config) && args.env) {
    throw new CommandLineArgsError(
      "In legacy environment mode you cannot use --name and --env together. If you want to specify a Worker name for a specific environment you can add the following to your wrangler.toml config:" +
        `
    [env.${args.env}]
    name = "${args.name}"
    `
    );
  }

  return args.name ?? config.name;
}

/**
 * Alternative to the getScriptName() because special Legacy cases allowed "name", and "env" together in Wrangler1
 */
function getLegacyScriptName(
  args: { name: string | undefined; env: string | undefined },
  config: Config
) {
  return args.name && args.env && isLegacyEnv(config)
    ? `${args.name}-${args.env}`
    : args.name ?? config.name;
}

/**
 * Get a promise to the streamed input from stdin.
 *
 * This function can be used to grab the incoming stream of data from, say,
 * piping the output of another process into the wrangler process.
 */
function readFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const chunks: string[] = [];

    // When there is data ready to be read, the `readable` event will be triggered.
    // In the handler for `readable` we call `read()` over and over until all the available data has been read.
    stdin.on("readable", () => {
      let chunk;
      while (null !== (chunk = stdin.read())) {
        chunks.push(chunk);
      }
    });

    // When the streamed data is complete the `end` event will be triggered.
    // In the handler for `end` we join the chunks together and resolve the promise.
    stdin.on("end", () => {
      resolve(chunks.join(""));
    });

    // If there is an `error` event then the handler will reject the promise.
    stdin.on("error", (err) => {
      reject(err);
    });
  });
}

// a helper to demand one of a set of options
// via https://github.com/yargs/yargs/issues/1093#issuecomment-491299261
function demandOneOfOption(...options: string[]) {
  return function (argv: Yargs.Arguments) {
    const count = options.filter((option) => argv[option]).length;
    const lastOption = options.pop();

    if (count === 0) {
      throw new CommandLineArgsError(
        `Exactly one of the arguments ${options.join(
          ", "
        )} and ${lastOption} is required`
      );
    } else if (count > 1) {
      throw new CommandLineArgsError(
        `Arguments ${options.join(
          ", "
        )} and ${lastOption} are mutually exclusive`
      );
    }

    return true;
  };
}

class CommandLineArgsError extends Error {}

export async function main(argv: string[]): Promise<void> {
  const wrangler = makeCLI(argv)
    .strict()
    // We handle errors ourselves in a try-catch around `yargs.parse`.
    // If you want the "help info" to be displayed then throw an instance of `CommandLineArgsError`.
    // Otherwise we just log the error that was thrown without any "help info".
    .showHelpOnFail(false)
    .fail((msg, error) => {
      if (!error) {
        // If there is only a `msg` then this came from yargs own validation, so wrap in a `CommandLineArgsError`.
        error = new CommandLineArgsError(msg);
      }
      throw error;
    })
    .scriptName("wrangler")
    .wrap(null);

  // Default help command that supports the subcommands
  const subHelp: CommandModule = {
    command: ["*"],
    handler: async (args) => {
      setImmediate(() =>
        wrangler.parse([...args._.map((a) => `${a}`), "--help"])
      );
    },
  };
  wrangler.command(
    ["*"],
    false,
    () => {},
    (args) => {
      if (args._.length > 0) {
        throw new CommandLineArgsError(`Unknown command: ${args._}.`);
      } else {
        wrangler.showHelp("log");
      }
    }
  );

  // You will note that we use the form for all commands where we use the builder function
  // to define options and subcommands.
  // Further we return the result of this builder even though it's not completely necessary.
  // The reason is that it's required for type inference of the args in the handle function.
  // I wish we could enforce this pattern, but this comment will have to do for now.
  // (It's also annoying that choices[] doesn't get inferred as an enum. 🤷‍♂.)

  // [DEPRECATED] generate
  wrangler.command(
    // we definitely want to move away from us cloning github templates
    // we can do something better here, let's see
    "generate [name] [template]",
    false,
    (yargs) => {
      return yargs
        .positional("name", {
          describe: "Name of the Workers project",
          default: "worker",
        })
        .positional("template", {
          describe: "a link to a GitHub template",
          default: "https://github.com/cloudflare/worker-template",
        });
    },
    () => {
      // "👯 [DEPRECATED]. Scaffold a Cloudflare Workers project from a public GitHub repository.",
      throw new DeprecationError(
        "`wrangler generate` has been deprecated, please refer to https://github.com/cloudflare/wrangler2/blob/main/docs/deprecations.md#generate for alternatives"
      );
    }
  );

  // init
  wrangler.command(
    "init [name]",
    "📥 Create a wrangler.toml configuration file",
    (yargs) => {
      return yargs
        .positional("name", {
          describe: "The name of your worker",
          type: "string",
        })
        .option("type", {
          describe: "The type of worker to create",
          type: "string",
          choices: ["rust", "javascript", "webpack"],
          deprecated: true,
        })
        .option("yes", {
          describe: 'Answer "yes" to any prompts for new projects',
          type: "boolean",
          alias: "y",
        });
    },
    async (args) => {
      await printWranglerBanner();
      if (args.type) {
        let message = "The --type option is no longer supported.";
        if (args.type === "webpack") {
          message +=
            "\nIf you wish to use webpack then you will need to create a custom build.";
          // TODO: Add a link to docs
        }
        throw new CommandLineArgsError(message);
      }

      // TODO: make sure args.name is a valid identifier for a worker name

      const creationDirectory = path.join(process.cwd(), args.name ?? "");
      const workerName = path
        .basename(creationDirectory)
        .toLowerCase()
        .replaceAll(/[^a-z0-9\-_]/gm, "-");

      const packageManager = await getPackageManager(creationDirectory);

      // TODO: ask which directory to make the worker in (defaults to args.name)
      // TODO: if args.name isn't provided, ask what to name the worker

      const wranglerTomlDestination = path.join(
        creationDirectory,
        "./wrangler.toml"
      );
      let justCreatedWranglerToml = false;

      if (fs.existsSync(wranglerTomlDestination)) {
        logger.warn(`${wranglerTomlDestination} file already exists!`);
        const shouldContinue = await confirm(
          "Do you want to continue initializing this project?"
        );
        if (!shouldContinue) {
          return;
        }
      } else {
        await mkdir(creationDirectory, { recursive: true });
        const compatibilityDate = new Date().toISOString().substring(0, 10);

        try {
          await writeFile(
            wranglerTomlDestination,
            TOML.stringify({
              name: workerName,
              compatibility_date: compatibilityDate,
            }) + "\n"
          );

          logger.log(`✨ Successfully created wrangler.toml`);
          justCreatedWranglerToml = true;
        } catch (err) {
          throw new Error(
            `Failed to create wrangler.toml.\n${(err as Error).message ?? err}`
          );
        }
      }

      let pathToPackageJson = await findUp("package.json");
      let shouldCreatePackageJson = false;
      const yesFlag = args.yes ?? false;
      if (!pathToPackageJson) {
        // If no package.json exists, ask to create one
        shouldCreatePackageJson =
          yesFlag ||
          (await confirm(
            "No package.json found. Would you like to create one?"
          ));

        if (shouldCreatePackageJson) {
          await writeFile(
            path.join(creationDirectory, "./package.json"),
            JSON.stringify(
              {
                name: workerName,
                version: "0.0.0",
                devDependencies: {
                  wrangler: wranglerVersion,
                },
                private: true,
              },
              null,
              "  "
            ) + "\n"
          );

          await packageManager.install();
          logger.log(`✨ Created package.json`);
          pathToPackageJson = path.join(creationDirectory, "package.json");
        } else {
          return;
        }
      } else {
        // If package.json exists and wrangler isn't installed,
        // then ask to add wrangler to devDependencies
        const packageJson = parseJSON(
          readFileSync(pathToPackageJson),
          pathToPackageJson
        );
        if (
          !(
            packageJson.devDependencies?.wrangler ||
            packageJson.dependencies?.wrangler
          )
        ) {
          const shouldInstall =
            yesFlag ||
            (await confirm(
              "Would you like to install wrangler into your package.json?"
            ));
          if (shouldInstall) {
            await packageManager.addDevDeps(`wrangler@${wranglerVersion}`);
            logger.log(`✨ Installed wrangler`);
          }
        }
      }

      let isTypescriptProject = false;
      let pathToTSConfig = await findUp("tsconfig.json");
      if (!pathToTSConfig) {
        // If there's no tsconfig, offer to create one
        // and install @cloudflare/workers-types
        if (yesFlag || (await confirm("Would you like to use TypeScript?"))) {
          isTypescriptProject = true;
          await writeFile(
            path.join(creationDirectory, "./tsconfig.json"),
            readFileSync(path.join(__dirname, "../templates/tsconfig.json"))
          );
          await packageManager.addDevDeps(
            "@cloudflare/workers-types",
            "typescript"
          );

          logger.log(
            `✨ Created tsconfig.json, installed @cloudflare/workers-types into devDependencies`
          );
          pathToTSConfig = path.join(creationDirectory, "tsconfig.json");
        }
      } else {
        isTypescriptProject = true;
        // If there's a tsconfig, check if @cloudflare/workers-types
        // is already installed, and offer to install it if not
        const packageJson = parseJSON(
          readFileSync(pathToPackageJson),
          pathToPackageJson
        );
        if (
          !(
            packageJson.devDependencies?.["@cloudflare/workers-types"] ||
            packageJson.dependencies?.["@cloudflare/workers-types"]
          )
        ) {
          const shouldInstall = await confirm(
            "Would you like to install the type definitions for Workers into your package.json?"
          );
          if (shouldInstall) {
            await packageManager.addDevDeps("@cloudflare/workers-types");
            // We don't update the tsconfig.json because
            // it could be complicated in existing projects
            // and we don't want to break them. Instead, we simply
            // tell the user that they need to update their tsconfig.json
            logger.log(
              `✨ Installed @cloudflare/workers-types.\nPlease add "@cloudflare/workers-types" to compilerOptions.types in your tsconfig.json`
            );
          }
        }
      }

      const packageJsonContent = parseJSON(
        readFileSync(pathToPackageJson),
        pathToPackageJson
      );
      const shouldWritePackageJsonScripts =
        !packageJsonContent.scripts?.start &&
        !packageJsonContent.scripts?.publish &&
        shouldCreatePackageJson;

      async function writePackageJsonScriptsAndUpdateWranglerToml(
        isWritingScripts: boolean,
        isCreatingWranglerToml: boolean,
        packagePath: string,
        scriptPath: string
      ) {
        if (isCreatingWranglerToml) {
          // rewrite wrangler.toml with main = "path/to/script"
          const parsedWranglerToml = parseTOML(
            readFileSync(wranglerTomlDestination)
          );
          fs.writeFileSync(
            wranglerTomlDestination,
            TOML.stringify({
              name: parsedWranglerToml.name,
              main: scriptPath,
              compatibility_date: parsedWranglerToml.compatibility_date,
            })
          );
        }
        const isNamedWorker =
          isCreatingWranglerToml && path.dirname(packagePath) !== process.cwd();

        if (isWritingScripts) {
          await writeFile(
            packagePath,
            JSON.stringify(
              {
                ...packageJsonContent,
                scripts: {
                  ...packageJsonContent.scripts,
                  start: isCreatingWranglerToml
                    ? `wrangler dev`
                    : `wrangler dev ${scriptPath}`,
                  publish: isCreatingWranglerToml
                    ? `wrangler publish`
                    : `wrangler publish ${scriptPath}`,
                },
              },
              null,
              2
            ) + "\n"
          );
          logger.log(
            `\nTo start developing your Worker, run \`${
              isNamedWorker ? `cd ${args.name} && ` : ""
            }npm start\``
          );
          logger.log(
            `To publish your Worker to the Internet, run \`npm run publish\``
          );
        } else {
          logger.log(
            `\nTo start developing your Worker, run \`npx wrangler dev\`${
              isCreatingWranglerToml ? "" : ` ${scriptPath}`
            }`
          );
          logger.log(
            `To publish your Worker to the Internet, run \`npx wrangler publish\`${
              isCreatingWranglerToml ? "" : ` ${scriptPath}`
            }`
          );
        }
      }

      if (isTypescriptProject) {
        if (!fs.existsSync(path.join(creationDirectory, "./src/index.ts"))) {
          let shouldCreateSource = false;

          shouldCreateSource =
            yesFlag ||
            (await confirm(
              `Would you like to create a Worker at src/index.ts?`
            ));

          if (shouldCreateSource) {
            await mkdir(path.join(creationDirectory, "./src"), {
              recursive: true,
            });
            await writeFile(
              path.join(creationDirectory, "./src/index.ts"),
              readFileSync(path.join(__dirname, "../templates/new-worker.ts"))
            );

            logger.log(`✨ Created src/index.ts`);

            await writePackageJsonScriptsAndUpdateWranglerToml(
              shouldWritePackageJsonScripts,
              justCreatedWranglerToml,
              pathToPackageJson,
              "src/index.ts"
            );
          }
        }
      } else {
        if (!fs.existsSync("./src/index.js")) {
          const shouldCreateSource = await confirm(
            `Would you like to create a Worker at src/index.js?`
          );
          if (shouldCreateSource) {
            await mkdir(path.join(creationDirectory, "./src"), {
              recursive: true,
            });
            await writeFile(
              path.join(path.join(creationDirectory, "./src/index.js")),
              readFileSync(path.join(__dirname, "../templates/new-worker.js"))
            );

            logger.log(`✨ Created src/index.js`);

            await writePackageJsonScriptsAndUpdateWranglerToml(
              shouldWritePackageJsonScripts,
              justCreatedWranglerToml,
              pathToPackageJson,
              "src/index.js"
            );
          }
        }
      }
    }
  );

  // build
  wrangler.command(
    "build",
    false,
    (yargs) => {
      return yargs.option("env", {
        describe: "Perform on a specific environment",
      });
    },
    () => {
      // "[DEPRECATED] 🦀 Build your project (if applicable)",
      throw new DeprecationError(
        "`wrangler build` has been deprecated, please refer to https://github.com/cloudflare/wrangler2/blob/main/docs/deprecations.md#build for alternatives"
      );
    }
  );

  // config
  wrangler.command(
    "config",
    false,
    () => {},
    () => {
      // "🕵️  Authenticate Wrangler with a Cloudflare API Token",
      throw new DeprecationError(
        "`wrangler config` has been deprecated, please refer to https://github.com/cloudflare/wrangler2/blob/main/docs/deprecations.md#config for alternatives"
      );
    }
  );

  // dev
  wrangler.command(
    "dev [script]",
    "👂 Start a local server for developing your worker",
    (yargs) => {
      return yargs
        .positional("script", {
          describe: "The path to an entry point for your worker",
          type: "string",
        })
        .option("name", {
          describe: "Name of the worker",
          type: "string",
        })
        .option("format", {
          choices: ["modules", "service-worker"] as const,
          describe: "Choose an entry type",
          deprecated: true,
        })
        .option("env", {
          describe: "Perform on a specific environment",
          type: "string",
          alias: "e",
        })
        .option("compatibility-date", {
          describe: "Date to use for compatibility checks",
          type: "string",
        })
        .option("compatibility-flags", {
          describe: "Flags to use for compatibility checks",
          alias: "compatibility-flag",
          type: "string",
          array: true,
        })
        .option("latest", {
          describe: "Use the latest version of the worker runtime",
          type: "boolean",
          default: true,
        })
        .option("ip", {
          describe: "IP address to listen on, defaults to `localhost`",
          type: "string",
        })
        .option("port", {
          describe: "Port to listen on",
          type: "number",
        })
        .option("inspector-port", {
          describe: "Port for devtools to connect to",
          type: "number",
        })
        .option("routes", {
          describe: "Routes to upload",
          alias: "route",
          type: "string",
          array: true,
        })
        .option("host", {
          type: "string",
          describe:
            "Host to forward requests to, defaults to the zone of project",
        })
        .option("local-protocol", {
          describe: "Protocol to listen to requests on, defaults to http.",
          choices: ["http", "https"] as const,
        })
        .option("experimental-public", {
          describe: "Static assets to be served",
          type: "string",
        })
        .option("site", {
          describe: "Root folder of static assets for Workers Sites",
          type: "string",
        })
        .option("site-include", {
          describe:
            "Array of .gitignore-style patterns that match file or directory names from the sites directory. Only matched items will be uploaded.",
          type: "string",
          array: true,
        })
        .option("site-exclude", {
          describe:
            "Array of .gitignore-style patterns that match file or directory names from the sites directory. Matched items will not be uploaded.",
          type: "string",
          array: true,
        })
        .option("upstream-protocol", {
          describe:
            "Protocol to forward requests to host on, defaults to https.",
          choices: ["http", "https"] as const,
        })
        .option("jsx-factory", {
          describe: "The function that is called for each JSX element",
          type: "string",
        })
        .option("jsx-fragment", {
          describe: "The function that is called for each JSX fragment",
          type: "string",
        })
        .option("tsconfig", {
          describe: "Path to a custom tsconfig.json file",
          type: "string",
        })
        .option("local", {
          alias: "l",
          describe: "Run on my machine",
          type: "boolean",
          default: false, // I bet this will a point of contention. We'll revisit it.
        })
        .option("experimental-enable-local-persistence", {
          describe: "Enable persistence for this session (only for local mode)",
          type: "boolean",
        })
        .option("minify", {
          describe: "Minify the script",
          type: "boolean",
        })
        .option("node-compat", {
          describe: "Enable node.js compaitibility",
          type: "boolean",
        });
    },
    async (args) => {
      await printWranglerBanner();
      const configPath =
        (args.config as ConfigPath) ||
        (args.script && findWranglerToml(path.dirname(args.script)));
      const config = readConfig(configPath, args);
      const entry = await getEntry(args, config, "dev");

      if (args["experimental-public"]) {
        logger.warn(
          "The --experimental-public field is experimental and will change in the future."
        );
      }

      if (args.public) {
        throw new Error(
          "The --public field has been renamed to --experimental-public, and will change behaviour in the future."
        );
      }

      const upstreamProtocol =
        args["upstream-protocol"] || config.dev.upstream_protocol;
      if (upstreamProtocol === "http") {
        logger.warn(
          "Setting upstream-protocol to http is not currently implemented.\n" +
            "If this is required in your project, please add your use case to the following issue:\n" +
            "https://github.com/cloudflare/wrangler2/issues/583."
        );
      }

      const accountId = !args.local ? await requireAuth(config) : undefined;

      // TODO: if worker_dev = false and no routes, then error (only for dev)

      /**
       * Given something that resembles a URL,
       * try to extract a host from it
       */
      function getHost(urlLike: string): string | undefined {
        if (
          !(urlLike.startsWith("http://") || urlLike.startsWith("https://"))
        ) {
          urlLike = "http://" + urlLike;
        }
        return new URL(urlLike).host;
      }

      /**
       * Given something that resembles a host,
       * try to infer a zone id from it
       */
      async function getZoneId(host: string): Promise<string | undefined> {
        const zones = await fetchResult<{ id: string }[]>(
          `/zones`,
          {},
          new URLSearchParams({ name: host })
        );
        return zones[0]?.id;
      }

      // When we're given a host (in one of the above ways), we do 2 things:
      // - We try to extract a host from it
      // - We try to get a zone id from the host
      //
      // So it turns out it's particularly hard to get a 'valid' domain
      // from a string, so we don't even try to validate TLDs, etc.
      // Once we get something that looks like w.x.y.z-ish, we then try to
      // get a zone id for it, by lopping off subdomains until we get a hit
      // from the API. That's it!

      let zone: { host: string; id: string } | undefined;

      if (!args.local) {
        const hostLike =
          args.host ||
          config.dev.host ||
          (args.routes && args.routes[0]) ||
          config.route ||
          (config.routes && config.routes[0]);

        let zoneId: string | undefined =
          typeof hostLike === "object" && "zone_id" in hostLike
            ? hostLike.zone_id
            : undefined;

        const host =
          typeof hostLike === "string"
            ? getHost(hostLike)
            : typeof hostLike === "object"
            ? "zone_name" in hostLike
              ? getHost(hostLike.zone_name)
              : getHost(hostLike.pattern)
            : undefined;

        const hostPieces =
          typeof host === "string" ? host.split(".") : undefined;

        while (!zoneId && hostPieces && hostPieces.length > 1) {
          zoneId = await getZoneId(hostPieces.join("."));
          hostPieces.shift();
        }

        if (host && !zoneId) {
          throw new Error(`Could not find zone for ${hostLike}`);
        }

        zone =
          typeof zoneId === "string" && typeof host === "string"
            ? {
                host,
                id: zoneId,
              }
            : undefined;
      }

      const nodeCompat = args.nodeCompat ?? config.node_compat;
      if (nodeCompat) {
        logger.warn(
          "Enabling node.js compatibility mode for builtins and globals. This is experimental and has serious tradeoffs. Please see https://github.com/ionic-team/rollup-plugin-node-polyfills/ for more details."
        );
      }

      const { waitUntilExit } = render(
        <Dev
          name={getScriptName(args, config)}
          entry={entry}
          env={args.env}
          zone={zone}
          rules={getRules(config)}
          legacyEnv={isLegacyEnv(config)}
          minify={args.minify ?? config.minify}
          nodeCompat={nodeCompat}
          build={config.build || {}}
          initialMode={args.local ? "local" : "remote"}
          jsxFactory={args["jsx-factory"] || config.jsx_factory}
          jsxFragment={args["jsx-fragment"] || config.jsx_fragment}
          tsconfig={args.tsconfig ?? config.tsconfig}
          upstreamProtocol={upstreamProtocol}
          localProtocol={args["local-protocol"] || config.dev.local_protocol}
          enableLocalPersistence={
            args["experimental-enable-local-persistence"] || false
          }
          accountId={accountId}
          assetPaths={getAssetPaths(
            config,
            args.site,
            args.siteInclude,
            args.siteExclude
          )}
          port={
            args.port || config.dev?.port || (await getPort({ port: 8787 }))
          }
          ip={args.ip || config.dev.ip}
          inspectorPort={
            args["inspector-port"] ?? (await getPort({ port: 9229 }))
          }
          public={args["experimental-public"]}
          compatibilityDate={getDevCompatibilityDate(
            config,
            args["compatibility-date"]
          )}
          compatibilityFlags={
            args["compatibility-flags"] || config.compatibility_flags
          }
          usageModel={config.usage_model}
          bindings={{
            kv_namespaces: config.kv_namespaces?.map(
              ({ binding, preview_id, id: _id }) => {
                // In `dev`, we make folks use a separate kv namespace called
                // `preview_id` instead of `id` so that they don't
                // break production data. So here we check that a `preview_id`
                // has actually been configured.
                // This whole block of code will be obsoleted in the future
                // when we have copy-on-write for previews on edge workers.
                if (!preview_id) {
                  // TODO: This error has to be a _lot_ better, ideally just asking
                  // to create a preview namespace for the user automatically
                  throw new Error(
                    `In development, you should use a separate kv namespace than the one you'd use in production. Please create a new kv namespace with "wrangler kv:namespace create <name> --preview" and add its id as preview_id to the kv_namespace "${binding}" in your wrangler.toml`
                  ); // Ugh, I really don't like this message very much
                }
                return {
                  binding,
                  id: preview_id,
                };
              }
            ),
            vars: config.vars,
            wasm_modules: config.wasm_modules,
            text_blobs: config.text_blobs,
            data_blobs: config.data_blobs,
            durable_objects: config.durable_objects,
            r2_buckets: config.r2_buckets,
            unsafe: config.unsafe?.bindings,
          }}
          crons={config.triggers.crons}
        />
      );
      await waitUntilExit();
    }
  );

  // publish
  wrangler.command(
    "publish [script]",
    "🆙 Publish your Worker to Cloudflare.",
    (yargs) => {
      return yargs
        .option("env", {
          type: "string",
          describe: "Perform on a specific environment",
          alias: "e",
        })
        .positional("script", {
          describe: "The path to an entry point for your worker",
          type: "string",
        })
        .option("name", {
          describe: "Name of the worker",
          type: "string",
        })
        .option("outdir", {
          describe: "Output directory for the bundled worker",
          type: "string",
        })
        .option("format", {
          choices: ["modules", "service-worker"] as const,
          describe: "Choose an entry type",
          deprecated: true,
        })
        .option("compatibility-date", {
          describe: "Date to use for compatibility checks",
          type: "string",
        })
        .option("compatibility-flags", {
          describe: "Flags to use for compatibility checks",
          alias: "compatibility-flag",
          type: "string",
          array: true,
        })
        .option("latest", {
          describe: "Use the latest version of the worker runtime",
          type: "boolean",
          default: false,
        })
        .option("experimental-public", {
          describe: "Static assets to be served",
          type: "string",
        })
        .option("site", {
          describe: "Root folder of static assets for Workers Sites",
          type: "string",
        })
        .option("site-include", {
          describe:
            "Array of .gitignore-style patterns that match file or directory names from the sites directory. Only matched items will be uploaded.",
          type: "string",
          array: true,
        })
        .option("site-exclude", {
          describe:
            "Array of .gitignore-style patterns that match file or directory names from the sites directory. Matched items will not be uploaded.",
          type: "string",
          array: true,
        })
        .option("triggers", {
          describe: "cron schedules to attach",
          alias: ["schedule", "schedules"],
          type: "string",
          array: true,
        })
        .option("routes", {
          describe: "Routes to upload",
          alias: "route",
          type: "string",
          array: true,
        })
        .option("jsx-factory", {
          describe: "The function that is called for each JSX element",
          type: "string",
        })
        .option("jsx-fragment", {
          describe: "The function that is called for each JSX fragment",
          type: "string",
        })
        .option("tsconfig", {
          describe: "Path to a custom tsconfig.json file",
          type: "string",
        })
        .option("minify", {
          describe: "Minify the script",
          type: "boolean",
        })
        .option("node-compat", {
          describe: "Enable node.js compaitibility",
          type: "boolean",
        })
        .option("dry-run", {
          describe: "Don't actually publish",
          type: "boolean",
        });
    },
    async (args) => {
      await printWranglerBanner();
      if (args["experimental-public"]) {
        logger.warn(
          "The --experimental-public field is experimental and will change in the future."
        );
      }
      if (args.public) {
        throw new Error(
          "The --public field has been renamed to --experimental-public, and will change behaviour in the future."
        );
      }

      const configPath =
        (args.config as ConfigPath) ||
        (args.script && findWranglerToml(path.dirname(args.script)));
      const config = readConfig(configPath, args);
      const entry = await getEntry(args, config, "publish");

      if (args.latest) {
        logger.warn(
          "Using the latest version of the Workers runtime. To silence this warning, please choose a specific version of the runtime with --compatibility-date, or add a compatibility_date to your wrangler.toml.\n"
        );
      }

      const accountId = await requireAuth(config);

      const assetPaths = getAssetPaths(
        config,
        args["experimental-public"] || args.site,
        args.siteInclude,
        args.siteExclude
      );
      await publish({
        config,
        accountId,
        name: getScriptName(args, config),
        rules: getRules(config),
        entry,
        env: args.env,
        compatibilityDate: args.latest
          ? new Date().toISOString().substring(0, 10)
          : args["compatibility-date"],
        compatibilityFlags: args["compatibility-flags"],
        triggers: args.triggers,
        jsxFactory: args["jsx-factory"],
        jsxFragment: args["jsx-fragment"],
        tsconfig: args.tsconfig,
        routes: args.routes,
        assetPaths,
        legacyEnv: isLegacyEnv(config),
        minify: args.minify,
        nodeCompat: args.nodeCompat,
        experimentalPublic: args["experimental-public"] !== undefined,
        outDir: args.outdir,
        dryRun: args.dryRun,
      });
    }
  );

  // tail
  wrangler.command(
    "tail [name]",
    "🦚 Starts a log tailing session for a published Worker.",
    (yargs) => {
      return yargs
        .positional("name", {
          describe: "Name of the worker",
          type: "string",
        })
        .option("format", {
          default: process.stdout.isTTY ? "pretty" : "json",
          choices: ["json", "pretty"],
          describe: "The format of log entries",
        })
        .option("status", {
          choices: ["ok", "error", "canceled"],
          describe: "Filter by invocation status",
          array: true,
        })
        .option("header", {
          type: "string",
          describe: "Filter by HTTP header",
        })
        .option("method", {
          type: "string",
          describe: "Filter by HTTP method",
          array: true,
        })
        .option("sampling-rate", {
          type: "number",
          describe: "Adds a percentage of requests to log sampling rate",
        })
        .option("search", {
          type: "string",
          describe: "Filter by a text match in console.log messages",
        })
        .option("ip", {
          type: "string",
          describe:
            'Filter by the IP address the request originates from. Use "self" to filter for your own IP',
          array: true,
        })
        .option("env", {
          type: "string",
          describe: "Perform on a specific environment",
          alias: "e",
        })
        .option("debug", {
          type: "boolean",
          hidden: true,
          default: false,
          describe:
            "If a log would have been filtered out, send it through anyway alongside the filter which would have blocked it.",
        });
    },
    async (args) => {
      if (args.format === "pretty") {
        await printWranglerBanner();
      }
      const config = readConfig(args.config as ConfigPath, args);

      const scriptName = getLegacyScriptName(args, config);

      if (!scriptName) {
        throw new Error("Missing script name");
      }

      const accountId = await requireAuth(config);

      const cliFilters: TailCLIFilters = {
        status: args.status as ("ok" | "error" | "canceled")[] | undefined,
        header: args.header,
        method: args.method,
        samplingRate: args["sampling-rate"],
        search: args.search,
        clientIp: args.ip,
      };

      const filters = translateCLICommandToFilterMessage(
        cliFilters,
        args.debug
      );

      const { tail, expiration, deleteTail } = await createTail(
        accountId,
        scriptName,
        filters,
        !isLegacyEnv(config) ? args.env : undefined
      );

      const scriptDisplayName = `${scriptName}${
        args.env && !isLegacyEnv(config) ? ` (${args.env})` : ""
      }`;

      if (args.format === "pretty") {
        logger.log(
          `Successfully created tail, expires at ${expiration.toLocaleString()}`
        );
      }

      onExit(async () => {
        tail.terminate();
        await deleteTail();
      });

      const printLog: (data: RawData) => void =
        args.format === "pretty" ? prettyPrintLogs : jsonPrintLogs;

      tail.on("message", printLog);

      while (tail.readyState !== tail.OPEN) {
        switch (tail.readyState) {
          case tail.CONNECTING:
            await setTimeout(100);
            break;
          case tail.CLOSING:
            await setTimeout(100);
            break;
          case tail.CLOSED:
            throw new Error(
              `Connection to ${scriptDisplayName} closed unexpectedly.`
            );
        }
      }

      if (args.format === "pretty") {
        logger.log(`Connected to ${scriptDisplayName}, waiting for logs...`);
      }

      tail.on("close", async () => {
        tail.terminate();
        await deleteTail();
      });
    }
  );

  // preview
  wrangler.command(
    "preview [method] [body]",
    false,
    (yargs) => {
      return yargs
        .positional("method", {
          type: "string",
          describe: "Type of request to preview your worker",
        })
        .positional("body", {
          type: "string",
          describe: "Body string to post to your preview worker request.",
        })
        .option("env", {
          type: "string",
          describe: "Perform on a specific environment",
        })
        .option("watch", {
          default: true,
          describe: "Enable live preview",
          type: "boolean",
        });
    },
    async (args) => {
      if (args.method || args.body) {
        throw new DeprecationError(
          "The `wrangler preview` command has been deprecated.\n" +
            "Try using `wrangler dev` to to try out a worker during development.\n"
        );
      }

      // Delegate to `wrangler dev`
      logger.warn(
        "***************************************************\n" +
          "The `wrangler preview` command has been deprecated.\n" +
          "Attempting to run `wrangler dev` instead.\n" +
          "***************************************************\n"
      );

      const config = readConfig(args.config as ConfigPath, args);
      const entry = await getEntry({}, config, "dev");

      const accountId = await requireAuth(config);

      const { waitUntilExit } = render(
        <Dev
          name={config.name}
          entry={entry}
          rules={getRules(config)}
          env={args.env}
          zone={undefined}
          legacyEnv={isLegacyEnv(config)}
          build={config.build || {}}
          minify={undefined}
          nodeCompat={config.node_compat}
          initialMode={args.local ? "local" : "remote"}
          jsxFactory={config.jsx_factory}
          jsxFragment={config.jsx_fragment}
          tsconfig={config.tsconfig}
          upstreamProtocol={config.dev.upstream_protocol}
          localProtocol={config.dev.local_protocol}
          enableLocalPersistence={false}
          accountId={accountId}
          assetPaths={undefined}
          port={config.dev?.port}
          ip={config.dev.ip}
          public={undefined}
          compatibilityDate={getDevCompatibilityDate(config)}
          compatibilityFlags={config.compatibility_flags}
          usageModel={config.usage_model}
          bindings={{
            kv_namespaces: config.kv_namespaces?.map(
              ({ binding, preview_id, id: _id }) => {
                // In `dev`, we make folks use a separate kv namespace called
                // `preview_id` instead of `id` so that they don't
                // break production data. So here we check that a `preview_id`
                // has actually been configured.
                // This whole block of code will be obsoleted in the future
                // when we have copy-on-write for previews on edge workers.
                if (!preview_id) {
                  // TODO: This error has to be a _lot_ better, ideally just asking
                  // to create a preview namespace for the user automatically
                  throw new Error(
                    `In development, you should use a separate kv namespace than the one you'd use in production. Please create a new kv namespace with "wrangler kv:namespace create <name> --preview" and add its id as preview_id to the kv_namespace "${binding}" in your wrangler.toml`
                  ); // Ugh, I really don't like this message very much
                }
                return {
                  binding,
                  id: preview_id,
                };
              }
            ),
            vars: config.vars,
            wasm_modules: config.wasm_modules,
            text_blobs: config.text_blobs,
            data_blobs: config.data_blobs,
            durable_objects: config.durable_objects,
            r2_buckets: config.r2_buckets,
            unsafe: config.unsafe?.bindings,
          }}
          crons={config.triggers.crons}
          inspectorPort={await getPort({ port: 9229 })}
        />
      );
      await waitUntilExit();
    }
  );

  // [DEPRECATED] route
  wrangler.command(
    "route",
    false, // I think we want to hide this command
    // "➡️  List or delete worker routes",
    (routeYargs) => {
      return routeYargs
        .command(
          "list",
          "List the routes associated with a zone",
          (yargs) => {
            return yargs
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
              })
              .option("zone", {
                type: "string",
                describe: "Zone id",
              })
              .positional("zone", {
                describe: "Zone id",
                type: "string",
              });
          },
          () => {
            // "👯 [DEPRECATED]. Use wrangler.toml to manage routes.
            const deprecationNotice =
              "`wrangler route list` has been deprecated.";
            const futureRoutes =
              "Refer to wrangler.toml for a list of routes the worker will be deployed to upon publishing.";
            const presentRoutes =
              "Refer to the Cloudflare Dashboard to see the routes this worker is currently running on.";
            throw new DeprecationError(
              `${deprecationNotice}\n${futureRoutes}\n${presentRoutes}`
            );
          }
        )
        .command(
          "delete [id]",
          "Delete a route associated with a zone",
          (yargs) => {
            return yargs
              .positional("id", {
                describe: "The hash of the route ID to delete.",
                type: "string",
              })
              .option("zone", {
                type: "string",
                describe: "zone id",
              })
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
              });
          },
          () => {
            // "👯 [DEPRECATED]. Use wrangler.toml to manage routes.
            const deprecationNotice =
              "`wrangler route delete` has been deprecated.";
            const shouldDo =
              "Remove the unwanted route(s) from wrangler.toml and run `wrangler publish` to remove your worker from those routes.";
            throw new DeprecationError(`${deprecationNotice}\n${shouldDo}`);
          }
        );
    },
    () => {
      // "👯 [DEPRECATED]. Use wrangler.toml to manage routes.
      const deprecationNotice = "`wrangler route` has been deprecated.";
      const shouldDo =
        "Please use wrangler.toml and/or `wrangler publish --routes` to modify routes";
      throw new DeprecationError(`${deprecationNotice}\n${shouldDo}`);
    }
  );

  // subdomain
  wrangler.command(
    "subdomain [name]",
    false,
    // "👷 Create or change your workers.dev subdomain.",
    (yargs) => {
      return yargs.positional("name", { type: "string" });
    },
    () => {
      throw new DeprecationError(
        "`wrangler subdomain` has been deprecated, please refer to https://github.com/cloudflare/wrangler2/blob/main/docs/deprecations.md#subdomain for alternatives"
      );
    }
  );

  // secret
  wrangler.command(
    "secret",
    "🤫 Generate a secret that can be referenced in the worker script",
    (secretYargs) => {
      return secretYargs
        .command(subHelp)
        .command(
          "put <key>",
          "Create or update a secret variable for a script",
          (yargs) => {
            return yargs
              .positional("key", {
                describe: "The variable name to be accessible in the script",
                type: "string",
              })
              .option("name", {
                describe: "Name of the worker",
                type: "string",
              })
              .option("env", {
                type: "string",
                describe:
                  "Binds the secret to the Worker of the specific environment",
                alias: "e",
              });
          },
          async (args) => {
            await printWranglerBanner();
            const config = readConfig(args.config as ConfigPath, args);

            const scriptName = getLegacyScriptName(args, config);
            if (!scriptName) {
              throw new Error("Missing script name");
            }

            const isInteractive = process.stdin.isTTY;
            const accountId = await requireAuth(config, isInteractive);

            const secretValue = isInteractive
              ? await prompt("Enter a secret value:", "password")
              : await readFromStdin();

            logger.log(
              `🌀 Creating the secret for script ${scriptName} ${
                args.env && !isLegacyEnv(config) ? `(${args.env})` : ""
              }`
            );

            async function submitSecret() {
              const url =
                !args.env || isLegacyEnv(config)
                  ? `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`
                  : `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}/secrets`;

              return await fetchResult(url, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: args.key,
                  text: secretValue,
                  type: "secret_text",
                }),
              });
            }

            const createDraftWorker = async () => {
              // TODO: log a warning
              await fetchResult(
                !isLegacyEnv(config) && args.env
                  ? `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}`
                  : `/accounts/${accountId}/workers/scripts/${scriptName}`,
                {
                  method: "PUT",
                  body: createWorkerUploadForm({
                    name: scriptName,
                    main: {
                      name: scriptName,
                      content: `export default { fetch() {} }`,
                      type: "esm",
                    },
                    bindings: {
                      kv_namespaces: [],
                      vars: {},
                      durable_objects: { bindings: [] },
                      r2_buckets: [],
                      wasm_modules: {},
                      text_blobs: {},
                      data_blobs: {},
                      unsafe: [],
                    },
                    modules: [],
                    migrations: undefined,
                    compatibility_date: undefined,
                    compatibility_flags: undefined,
                    usage_model: undefined,
                  }),
                }
              );
            };

            function isMissingWorkerError(e: unknown): e is { code: 10007 } {
              return (
                typeof e === "object" &&
                e !== null &&
                (e as { code: number }).code === 10007
              );
            }

            try {
              await submitSecret();
            } catch (e) {
              if (isMissingWorkerError(e)) {
                // create a draft worker and try again
                await createDraftWorker();
                await submitSecret();
                // TODO: delete the draft worker if this failed too?
              } else {
                throw e;
              }
            }

            logger.log(`✨ Success! Uploaded secret ${args.key}`);
          }
        )
        .command(
          "delete <key>",
          "Delete a secret variable from a script",
          async (yargs) => {
            await printWranglerBanner();
            return yargs
              .positional("key", {
                describe: "The variable name to be accessible in the script",
                type: "string",
              })
              .option("name", {
                describe: "Name of the worker",
                type: "string",
              })
              .option("env", {
                type: "string",
                describe:
                  "Binds the secret to the Worker of the specific environment",
                alias: "e",
              });
          },
          async (args) => {
            const config = readConfig(args.config as ConfigPath, args);

            const scriptName = getLegacyScriptName(args, config);
            if (!scriptName) {
              throw new Error("Missing script name");
            }

            const accountId = await requireAuth(config);

            if (
              await confirm(
                `Are you sure you want to permanently delete the variable ${
                  args.key
                } on the script ${scriptName}${
                  args.env && !isLegacyEnv(config) ? ` (${args.env})` : ""
                }?`
              )
            ) {
              logger.log(
                `🌀 Deleting the secret ${args.key} on script ${scriptName}${
                  args.env && !isLegacyEnv(config) ? ` (${args.env})` : ""
                }`
              );

              const url =
                !args.env || isLegacyEnv(config)
                  ? `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`
                  : `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}/secrets`;

              await fetchResult(`${url}/${args.key}`, { method: "DELETE" });
              logger.log(`✨ Success! Deleted secret ${args.key}`);
            }
          }
        )
        .command(
          "list",
          "List all secrets for a script",
          (yargs) => {
            return yargs
              .option("name", {
                describe: "Name of the worker",
                type: "string",
              })
              .option("env", {
                type: "string",
                describe:
                  "Binds the secret to the Worker of the specific environment.",
                alias: "e",
              });
          },
          async (args) => {
            const config = readConfig(args.config as ConfigPath, args);

            const scriptName = getLegacyScriptName(args, config);
            if (!scriptName) {
              throw new Error("Missing script name");
            }

            const accountId = await requireAuth(config);

            const url =
              !args.env || isLegacyEnv(config)
                ? `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`
                : `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}/secrets`;

            logger.log(JSON.stringify(await fetchResult(url), null, "  "));
          }
        );
    }
  );

  // kv
  // :namespace
  wrangler.command(
    "kv:namespace",
    "🗂️  Interact with your Workers KV Namespaces",
    (namespaceYargs) => {
      return namespaceYargs
        .command(subHelp)
        .command(
          "create <namespace>",
          "Create a new namespace",
          (yargs) => {
            return yargs
              .positional("namespace", {
                describe: "The name of the new namespace",
                type: "string",
                demandOption: true,
              })
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
                alias: "e",
              })
              .option("preview", {
                type: "boolean",
                describe: "Interact with a preview namespace",
              });
          },
          async (args) => {
            await printWranglerBanner();

            if (!isValidNamespaceBinding(args.namespace)) {
              throw new CommandLineArgsError(
                `The namespace binding name "${args.namespace}" is invalid. It can only have alphanumeric and _ characters, and cannot begin with a number.`
              );
            }

            const config = readConfig(args.config as ConfigPath, args);
            if (!config.name) {
              logger.warn(
                "No configured name present, using `worker` as a prefix for the title"
              );
            }

            const name = config.name || "worker";
            const environment = args.env ? `-${args.env}` : "";
            const preview = args.preview ? "_preview" : "";
            const title = `${name}${environment}-${args.namespace}${preview}`;

            const accountId = await requireAuth(config);

            // TODO: generate a binding name stripping non alphanumeric chars

            logger.log(`🌀 Creating namespace with title "${title}"`);
            const namespaceId = await createNamespace(accountId, title);

            logger.log("✨ Success!");
            const envString = args.env ? ` under [env.${args.env}]` : "";
            const previewString = args.preview ? "preview_" : "";
            logger.log(
              `Add the following to your configuration file in your kv_namespaces array${envString}:`
            );
            logger.log(
              `{ binding = "${args.namespace}", ${previewString}id = "${namespaceId}" }`
            );

            // TODO: automatically write this block to the wrangler.toml config file??
          }
        )
        .command(
          "list",
          "Outputs a list of all KV namespaces associated with your account id.",
          {},
          async (args) => {
            const config = readConfig(args.config as ConfigPath, args);

            const accountId = await requireAuth(config);

            // TODO: we should show bindings if they exist for given ids

            logger.log(
              JSON.stringify(await listNamespaces(accountId), null, "  ")
            );
          }
        )
        .command(
          "delete",
          "Deletes a given namespace.",
          (yargs) => {
            return yargs
              .option("binding", {
                type: "string",
                describe: "The name of the namespace to delete",
              })
              .option("namespace-id", {
                type: "string",
                describe: "The id of the namespace to delete",
              })
              .check(demandOneOfOption("binding", "namespace-id"))
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
                alias: "e",
              })
              .option("preview", {
                type: "boolean",
                describe: "Interact with a preview namespace",
              });
          },
          async (args) => {
            await printWranglerBanner();
            const config = readConfig(args.config as ConfigPath, args);

            let id;
            try {
              id = getNamespaceId(args, config);
            } catch (e) {
              throw new CommandLineArgsError(
                "Not able to delete namespace.\n" + ((e as Error).message ?? e)
              );
            }

            const accountId = await requireAuth(config);

            await fetchResult<{ id: string }>(
              `/accounts/${accountId}/storage/kv/namespaces/${id}`,
              { method: "DELETE" }
            );

            // TODO: recommend they remove it from wrangler.toml

            // test-mf wrangler kv:namespace delete --namespace-id 2a7d3d8b23fc4159b5afa489d6cfd388
            // Are you sure you want to delete namespace 2a7d3d8b23fc4159b5afa489d6cfd388? [y/n]
            // n
            // 💁  Not deleting namespace 2a7d3d8b23fc4159b5afa489d6cfd388
            // ➜  test-mf wrangler kv:namespace delete --namespace-id 2a7d3d8b23fc4159b5afa489d6cfd388
            // Are you sure you want to delete namespace 2a7d3d8b23fc4159b5afa489d6cfd388? [y/n]
            // y
            // 🌀  Deleting namespace 2a7d3d8b23fc4159b5afa489d6cfd388
            // ✨  Success
            // ⚠️  Make sure to remove this "kv-namespace" entry from your configuration file!
            // ➜  test-mf

            // TODO: do it automatically

            // TODO: delete the preview namespace as well?
          }
        );
    }
  );

  // :key
  wrangler.command(
    "kv:key",
    "🔑 Individually manage Workers KV key-value pairs",
    (kvKeyYargs) => {
      return kvKeyYargs
        .command(subHelp)
        .command(
          "put <key> [value]",
          "Writes a single key/value pair to the given namespace.",
          (yargs) => {
            return yargs
              .positional("key", {
                type: "string",
                describe: "The key to write to",
                demandOption: true,
              })
              .positional("value", {
                type: "string",
                describe: "The value to write",
              })
              .option("binding", {
                type: "string",
                describe: "The binding of the namespace to write to",
              })
              .option("namespace-id", {
                type: "string",
                describe: "The id of the namespace to write to",
              })
              .check(demandOneOfOption("binding", "namespace-id"))
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
                alias: "e",
              })
              .option("preview", {
                type: "boolean",
                describe: "Interact with a preview namespace",
              })
              .option("ttl", {
                type: "number",
                describe: "Time for which the entries should be visible",
              })
              .option("expiration", {
                type: "number",
                describe:
                  "Time since the UNIX epoch after which the entry expires",
              })
              .option("path", {
                type: "string",
                describe: "Read value from the file at a given path",
              })
              .check(demandOneOfOption("value", "path"));
          },
          async ({ key, ttl, expiration, ...args }) => {
            await printWranglerBanner();
            const config = readConfig(args.config as ConfigPath, args);
            const namespaceId = getNamespaceId(args, config);
            // One of `args.path` and `args.value` must be defined
            const value = args.path
              ? readFileSync(args.path)
              : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                args.value!;

            if (args.path) {
              logger.log(
                `Writing the contents of ${args.path} to the key "${key}" on namespace ${namespaceId}.`
              );
            } else {
              logger.log(
                `Writing the value "${value}" to key "${key}" on namespace ${namespaceId}.`
              );
            }

            const accountId = await requireAuth(config);

            await putKeyValue(accountId, namespaceId, {
              key,
              value,
              expiration,
              expiration_ttl: ttl,
            });
          }
        )
        .command(
          "list",
          "Outputs a list of all keys in a given namespace.",
          (yargs) => {
            return yargs
              .option("binding", {
                type: "string",
                describe: "The name of the namespace to list",
              })
              .option("namespace-id", {
                type: "string",
                describe: "The id of the namespace to list",
              })
              .check(demandOneOfOption("binding", "namespace-id"))
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
                alias: "e",
              })
              .option("preview", {
                type: "boolean",
                // In the case of listing keys we will default to non-preview mode
                default: false,
                describe: "Interact with a preview namespace",
              })
              .option("prefix", {
                type: "string",
                describe: "A prefix to filter listed keys",
              });
          },
          async ({ prefix, ...args }) => {
            // TODO: support for limit+cursor (pagination)
            const config = readConfig(args.config as ConfigPath, args);
            const namespaceId = getNamespaceId(args, config);

            const accountId = await requireAuth(config);

            const results = await listNamespaceKeys(
              accountId,
              namespaceId,
              prefix
            );
            logger.log(JSON.stringify(results, undefined, 2));
          }
        )
        .command(
          "get <key>",
          "Reads a single value by key from the given namespace.",
          (yargs) => {
            return yargs
              .positional("key", {
                describe: "The key value to get.",
                type: "string",
                demandOption: true,
              })
              .option("binding", {
                type: "string",
                describe: "The name of the namespace to get from",
              })
              .option("namespace-id", {
                type: "string",
                describe: "The id of the namespace to get from",
              })
              .check(demandOneOfOption("binding", "namespace-id"))
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
                alias: "e",
              })
              .option("preview", {
                type: "boolean",
                describe: "Interact with a preview namespace",
              })
              .option("preview", {
                type: "boolean",
                // In the case of getting key values we will default to non-preview mode
                default: false,
                describe: "Interact with a preview namespace",
              });
          },
          async ({ key, ...args }) => {
            const config = readConfig(args.config as ConfigPath, args);
            const namespaceId = getNamespaceId(args, config);

            const accountId = await requireAuth(config);

            logger.log(await getKeyValue(accountId, namespaceId, key));
          }
        )
        .command(
          "delete <key>",
          "Removes a single key value pair from the given namespace.",
          (yargs) => {
            return yargs
              .positional("key", {
                describe: "The key value to delete",
                type: "string",
                demandOption: true,
              })
              .option("binding", {
                type: "string",
                describe: "The name of the namespace to delete from",
              })
              .option("namespace-id", {
                type: "string",
                describe: "The id of the namespace to delete from",
              })
              .check(demandOneOfOption("binding", "namespace-id"))
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
                alias: "e",
              })
              .option("preview", {
                type: "boolean",
                describe: "Interact with a preview namespace",
              });
          },
          async ({ key, ...args }) => {
            await printWranglerBanner();
            const config = readConfig(args.config as ConfigPath, args);
            const namespaceId = getNamespaceId(args, config);

            logger.log(
              `Deleting the key "${key}" on namespace ${namespaceId}.`
            );

            const accountId = await requireAuth(config);

            await fetchResult(
              `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
              { method: "DELETE" }
            );
          }
        );
    }
  );

  // :bulk
  wrangler.command(
    "kv:bulk",
    "💪 Interact with multiple Workers KV key-value pairs at once",
    (kvBulkYargs) => {
      return kvBulkYargs
        .command(subHelp)
        .command(
          "put <filename>",
          "Upload multiple key-value pairs to a namespace",
          (yargs) => {
            return yargs
              .positional("filename", {
                describe: `The JSON file of key-value pairs to upload, in form [{"key":..., "value":...}"...]`,
                type: "string",
                demandOption: true,
              })
              .option("binding", {
                type: "string",
                describe: "The name of the namespace to insert values into",
              })
              .option("namespace-id", {
                type: "string",
                describe: "The id of the namespace to insert values into",
              })
              .check(demandOneOfOption("binding", "namespace-id"))
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
                alias: "e",
              })
              .option("preview", {
                type: "boolean",
                describe: "Interact with a preview namespace",
              });
          },
          async ({ filename, ...args }) => {
            await printWranglerBanner();
            // The simplest implementation I could think of.
            // This could be made more efficient with a streaming parser/uploader
            // but we'll do that in the future if needed.

            const config = readConfig(args.config as ConfigPath, args);
            const namespaceId = getNamespaceId(args, config);
            const content = parseJSON(readFileSync(filename), filename);

            if (!Array.isArray(content)) {
              throw new Error(
                `Unexpected JSON input from "${filename}".\n` +
                  `Expected an array of key-value objects but got type "${typeof content}".`
              );
            }

            const errors: string[] = [];
            const warnings: string[] = [];
            for (let i = 0; i < content.length; i++) {
              const keyValue = content[i];
              if (typeof keyValue !== "object") {
                errors.push(
                  `The item at index ${i} is type: "${typeof keyValue}" - ${JSON.stringify(
                    keyValue
                  )}`
                );
              } else if (!isKeyValue(keyValue)) {
                errors.push(
                  `The item at index ${i} is ${JSON.stringify(keyValue)}`
                );
              } else {
                const props = unexpectedKeyValueProps(keyValue);
                if (props.length > 0) {
                  warnings.push(
                    `The item at index ${i} contains unexpected properties: ${JSON.stringify(
                      props
                    )}.`
                  );
                }
              }
            }
            if (warnings.length > 0) {
              logger.warn(
                `Unexpected key-value properties in "${filename}".\n` +
                  warnings.join("\n")
              );
            }
            if (errors.length > 0) {
              throw new Error(
                `Unexpected JSON input from "${filename}".\n` +
                  `Each item in the array should be an object that matches:\n\n` +
                  `interface KeyValue {\n` +
                  `  key: string;\n` +
                  `  value: string;\n` +
                  `  expiration?: number;\n` +
                  `  expiration_ttl?: number;\n` +
                  `  metadata?: object;\n` +
                  `  base64?: boolean;\n` +
                  `}\n\n` +
                  errors.join("\n")
              );
            }

            const accountId = await requireAuth(config);
            await putBulkKeyValue(
              accountId,
              namespaceId,
              content,
              (index, total) => {
                logger.log(`Uploaded ${index} of ${total}.`);
              }
            );

            logger.log("Success!");
          }
        )
        .command(
          "delete <filename>",
          "Delete multiple key-value pairs from a namespace",
          (yargs) => {
            return yargs
              .positional("filename", {
                describe: `The JSON file of keys to delete, in the form ["key1", "key2", ...]`,
                type: "string",
                demandOption: true,
              })
              .option("binding", {
                type: "string",
                describe: "The name of the namespace to delete from",
              })
              .option("namespace-id", {
                type: "string",
                describe: "The id of the namespace to delete from",
              })
              .check(demandOneOfOption("binding", "namespace-id"))
              .option("env", {
                type: "string",
                describe: "Perform on a specific environment",
                alias: "e",
              })
              .option("preview", {
                type: "boolean",
                describe: "Interact with a preview namespace",
              })
              .option("force", {
                type: "boolean",
                alias: "f",
                describe: "Do not ask for confirmation before deleting",
              });
          },
          async ({ filename, ...args }) => {
            await printWranglerBanner();
            const config = readConfig(args.config as ConfigPath, args);
            const namespaceId = getNamespaceId(args, config);

            if (!args.force) {
              const result = await confirm(
                `Are you sure you want to delete all the keys read from "${filename}" from kv-namespace with id "${namespaceId}"?`
              );
              if (!result) {
                logger.log(`Not deleting keys read from "${filename}".`);
                return;
              }
            }

            const content = parseJSON(
              readFileSync(filename),
              filename
            ) as string[];

            if (!Array.isArray(content)) {
              throw new Error(
                `Unexpected JSON input from "${filename}".\n` +
                  `Expected an array of strings but got:\n${content}`
              );
            }

            const errors: string[] = [];
            for (let i = 0; i < content.length; i++) {
              const key = content[i];
              if (typeof key !== "string") {
                errors.push(
                  `The item at index ${i} is type: "${typeof key}" - ${JSON.stringify(
                    key
                  )}`
                );
              }
            }
            if (errors.length > 0) {
              throw new Error(
                `Unexpected JSON input from "${filename}".\n` +
                  `Expected an array of strings.\n` +
                  errors.join("\n")
              );
            }

            const accountId = await requireAuth(config);

            await deleteBulkKeyValue(
              accountId,
              namespaceId,
              content,
              (index, total) => {
                logger.log(`Deleted ${index} of ${total}.`);
              }
            );

            logger.log("Success!");
          }
        );
    }
  );

  wrangler.command(
    "pages",
    "⚡️ Configure Cloudflare Pages",
    async (pagesYargs) => {
      await pages(pagesYargs.command(subHelp).epilogue(pagesBetaWarning));
    }
  );

  wrangler.command("r2", "📦 Interact with an R2 store", (r2Yargs) => {
    return r2Yargs
      .command(subHelp)
      .command("bucket", "Manage R2 buckets", (r2BucketYargs) => {
        r2BucketYargs.command(
          "create <name>",
          "Create a new R2 bucket",
          (yargs) => {
            return yargs.positional("name", {
              describe: "The name of the new bucket",
              type: "string",
              demandOption: true,
            });
          },
          async (args) => {
            await printWranglerBanner();

            const config = readConfig(args.config as ConfigPath, args);

            const accountId = await requireAuth(config);

            logger.log(`Creating bucket ${args.name}.`);
            await createR2Bucket(accountId, args.name);
            logger.log(`Created bucket ${args.name}.`);
          }
        );

        r2BucketYargs.command("list", "List R2 buckets", {}, async (args) => {
          const config = readConfig(args.config as ConfigPath, args);

          const accountId = await requireAuth(config);

          logger.log(JSON.stringify(await listR2Buckets(accountId), null, 2));
        });

        r2BucketYargs.command(
          "delete <name>",
          "Delete an R2 bucket",
          (yargs) => {
            return yargs.positional("name", {
              describe: "The name of the bucket to delete",
              type: "string",
              demandOption: true,
            });
          },
          async (args) => {
            await printWranglerBanner();

            const config = readConfig(args.config as ConfigPath, args);

            const accountId = await requireAuth(config);

            logger.log(`Deleting bucket ${args.name}.`);
            await deleteR2Bucket(accountId, args.name);
            logger.log(`Deleted bucket ${args.name}.`);
          }
        );
        return r2BucketYargs;
      }

      );
  });

  wrangler.command("pubsub", "🗞  Interact with programmable mqtt on the edge", (pubsubYargs) => {
    return pubsubYargs
      .command(subHelp)
      .command("namespaces", "Manage Pub/Sub Namespaces", (pubsubNamespaceYargs) => {
        pubsubNamespaceYargs.command(
          "create <name>",
          "Create a new Pub/Sub Namespance",
          (yargs) => {
            return yargs.
              positional("name", {
                describe: "The name of the new namespace",
                type: "string",
                demandOption: true,
              }).
              option("description", {
                describe: "Textual description of namespace",
                type: "string",
              });
          },
          async (args) => {
            await printWranglerBanner();

            const config = readConfig(args.config as ConfigPath, args);

            const accountId = await requireAuth(config);

            const namespace: pubsub.Namespace = {
              name: args.name,
            }
            if (args.description) {
              namespace.description = args.description
            }

            logger.log(`Creating namespace ${args.name}.`);
            await pubsub.createNamespace(accountId, namespace);
            logger.log(`Created namespace ${args.name}.`);
          }
        );

        pubsubNamespaceYargs.command("list", "List pubsub namespace", {}, async (args) => {
          const config = readConfig(args.config as ConfigPath, args);

          const accountId = await requireAuth(config);

          logger.log(JSON.stringify(await pubsub.listNamespaces(accountId), null, 2));
        });

        pubsubNamespaceYargs.command(
          "delete <name>",
          "Delete a Pub/Sub Namespace",
          (yargs) => {
            return yargs.positional("name", {
              describe: "The name of the namespace to delete",
              type: "string",
              demandOption: true,
            });
          },
          async (args) => {
            await printWranglerBanner();

            const config = readConfig(args.config as ConfigPath, args);

            const accountId = await requireAuth(config);

            logger.log(`Deleting namespace ${args.name}.`);
            await pubsub.deleteNamespace(accountId, args.name);
            logger.log(`Deleted namespace ${args.name}.`);
          }
        );
        return pubsubNamespaceYargs;
      })
      .command("brokers", "Manage pubsub brokers", (brokersYargs) => {
        brokersYargs.command(
          "create <name>",
          "Create a new Pub/Sub Broker",
          yargs => yargs
            .positional("name", {
              describe: "The name of the broker",
              type: "string",
              demandOption: true,
            })
            .option("namespace", {
              describe: "The namespace to create the broker",
              type: "string",
              alias: "ns",
              demandOption: true,
            })
            .option("description", {
              describe: "Longer description for the broker",
              type: "string",
            })
            .option("expiration", {
              describe: "Time to allow token validity (can use seconds, hours, months, weeks, years)",
              type: "string",
            })
            .option("on_publish", {
              describe: "Webhook to call upon publishing messages",
              type: "string",
            })
            ,
          async args => {
            const config = readConfig(args.config as ConfigPath, args);

            const accountId = await requireAuth(config);

            const broker: pubsub.Broker = {
              name: args.name,
            };
            if (args.description) {
              broker.description = args.description
            }
            if (args.expiration) {
              const expiration = parseHumanDuration(args.expiration)
              if (isNaN(expiration)) {
                throw new CommandLineArgsError(
                  `${args.expiration} is not a time duration.  (Example of valid values are: 1y, 6 days)`
                );
              }
              broker.expiration = expiration
            }
            if (args.on_publish) {
              broker.on_publish = {
                url: args.on_publish
              }
            }
            logger.log(JSON.stringify(await pubsub.createBroker(accountId, args.namespace, broker), null, 2));
          }
        );

        brokersYargs.command(
          "update <name>",
          "Update a configuration for Pub/Sub Broker",
          yargs => yargs
            .positional("name", {
              describe: "The name of the broker",
              type: "string",
              demandOption: true,
            })
            .option("namespace", {
              describe: "The namespace to create the broker",
              type: "string",
              alias: "ns",
              demandOption: true,
            })
            .option("description", {
              describe: "Longer description for the broker",
              type: "string",
            })
            .option("expiration", {
              describe: "Time to allow token validity (can use seconds, hours, months, weeks, years)",
              type: "string",
            })
            .option("on_publish", {
              describe: "Webhook to call upon publishing messages",
              type: "string",
            })
            ,
          async args => {
            const config = readConfig(args.config as ConfigPath, args);
            const accountId = await requireAuth(config);

            const broker: pubsub.Broker = {};
            if (args.description) {
              broker.description = args.description
            }
            if (args.expiration) {
              const expiration = parseHumanDuration(args.expiration)
              if (isNaN(expiration)) {
                throw new CommandLineArgsError(
                  `${args.expiration} is not a time duration.  (Example of valid values are: 1y, 6 days)`
                );
              }
              broker.expiration = expiration
            }
            if (args.on_publish) {
              broker.on_publish = {
                url: args.on_publish
              }
            }
            logger.log(JSON.stringify(await pubsub.updateBroker(accountId, args.namespace, args.name, broker), null, 2));
          }
        );

        brokersYargs.command(
          "list", 
          "List Pub/Sub Brokers", 
          (yargs) => {
            return yargs
              .option("namespace", {
                describe: "The namespace to create the broker",
                type: "string",
                alias: "ns",
                demandOption: true,
              });
          }, 
          async (args) => {
            const config = readConfig(args.config as ConfigPath, args);

            const accountId = await requireAuth(config);

            logger.log(JSON.stringify(await pubsub.listBrokers(accountId, args.namespace), null, 2));
          }
        );

        brokersYargs.command(
          "delete <name>",
          "Delete a Pub/Sub Broker",
          (yargs) => {
            return yargs
              .positional("name", {
                describe: "The name of the namespace to delete",
                type: "string",
                demandOption: true,
              })
              .option("namespace", {
                describe: "The namespace to create the broker",
                type: "string",
                alias: "ns",
                demandOption: true,
              });
          },
          async (args) => {
            await printWranglerBanner();

            const config = readConfig(args.config as ConfigPath, args);

            const accountId = await requireAuth(config);

            logger.log(`Deleting namespace ${args.name}.`);
            await pubsub.deleteBroker(accountId, args.namespace, args.name);
            logger.log(`Deleted namespace ${args.name}.`);
          }
        );

        return brokersYargs;
      })
      .command(
        'issue <broker>', 
        'Issue new client tokens', 
        yargs => {
          return yargs
            .positional('broker',{
              describe: "FQDN of the broker",
              type: "string",
              demandOption: true,
            })
            .option("number", {
              describe: "The number of tokens to generate",
              type: "number",
              alias: "n",
              default: 1,
            });
        }, async args => {
          const config = readConfig(args.config as ConfigPath, args);
          const accountId = await requireAuth(config);
          const [namespace, broker] = await pubsub.lookupBroker(args.broker)

          logger.log(JSON.stringify(await pubsub.issueTokens(accountId, namespace, broker, args.number), null, 2));
        }
      )
      .command(
        'revoke <broker> <jti..>', 
        'Revoke access for client tokens', 
        (yargs) => {
          return yargs
            .positional('broker',{
              describe: "FQDN of the broker",
              type: "string",
              demandOption: true,
            })
            .positional("jti", {
              describe: "Tokens to revoke",
              type: "string",
              demandOption: true,
              array: true,
            });
        }, 
        async args => {
          const config = readConfig(args.config as ConfigPath, args);
          const accountId = await requireAuth(config);
          const [namespace, broker] = await pubsub.lookupBroker(args.broker)

          logger.log('Revoking access to ${args.broker} for:')
          logger.log(' ', args.jti.join(' '))

          await pubsub.revokeTokens(accountId, namespace, broker, ...args.jti);

          logger.log('Revoked.')
        }
      )
      .command(
        'unrevoke <broker> <jti..>',  
        'Restore access for client tokens', 
        (yargs) => {
          return yargs
            .positional('broker',{
              describe: "FQDN of the broker",
              type: "string",
              demandOption: true,
            })
            .positional("jti", {
              describe: "Tokens to revoke",
              type: "string",
              demandOption: true,
              array: true,
            });
        }, 
        async args => {
          const config = readConfig(args.config as ConfigPath, args);
          const accountId = await requireAuth(config);
          const [namespace, broker] = await pubsub.lookupBroker(args.broker)

          logger.log('Restoring access to ${args.broker} for:')
          logger.log(' ', args.jti.join(' '))

          await pubsub.unrevokeTokens(accountId, namespace, broker, ...args.jti);

          logger.log('Unrevoked.')
        }
      );
  });


  /**
   * User Group: login, logout, and whoami
   * TODO: group commands into User group similar to .group() for flags in yargs
   */
  // login
  wrangler.command(
    // this needs scopes as an option?
    "login",
    "🔓 Login to Cloudflare",
    (yargs) => {
      // TODO: This needs some copy editing
      // I mean, this entire app does, but this too.
      return yargs
        .option("scopes-list", {
          describe: "List all the available OAuth scopes with descriptions",
        })
        .option("scopes", {
          describe: "Pick the set of applicable OAuth scopes when logging in",
          array: true,
          type: "string",
        });

      // TODO: scopes
    },
    async (args) => {
      await printWranglerBanner();
      if (args["scopes-list"]) {
        listScopes();
        return;
      }
      if (args.scopes) {
        if (args.scopes.length === 0) {
          // don't allow no scopes to be passed, that would be weird
          listScopes();
          return;
        }
        if (!validateScopeKeys(args.scopes)) {
          throw new CommandLineArgsError(
            `One of ${args.scopes} is not a valid authentication scope. Run "wrangler login --list-scopes" to see the valid scopes.`
          );
        }
        await login({ scopes: args.scopes });
        return;
      }
      await login();

      // TODO: would be nice if it optionally saved login
      // credentials inside node_modules/.cache or something
      // this way you could have multiple users on a single machine
    }
  );

  // logout
  wrangler.command(
    // this needs scopes as an option?
    "logout",
    "🚪 Logout from Cloudflare",
    () => {},
    async () => {
      await printWranglerBanner();
      await logout();
    }
  );

  // whoami
  wrangler.command(
    "whoami",
    "🕵️  Retrieve your user info and test your auth config",
    () => {},
    async () => {
      await printWranglerBanner();
      await whoami();
    }
  );

  wrangler
    .option("legacy-env", {
      type: "boolean",
      describe: "Use legacy environments",
    })
    .option("config", {
      alias: "c",
      describe: "Path to .toml configuration file",
      type: "string",
    });

  wrangler.group(["config", "help", "version", "legacy-env"], "Flags:");
  wrangler.help().alias("h", "help");
  wrangler.version(wranglerVersion).alias("v", "version");
  wrangler.exitProcess(false);

  try {
    await wrangler.parse();
  } catch (e) {
    logger.log(""); // Just adds a bit of space
    if (e instanceof CommandLineArgsError) {
      wrangler.showHelp("error");
      logger.error(e.message);
    } else if (e instanceof ParseError) {
      e.notes.push({
        text: "\nIf you think this is a bug, please open an issue at: https://github.com/cloudflare/wrangler2/issues/new",
      });
      logger.error(formatMessage(e));
    } else {
      logger.error(e instanceof Error ? e.message : e);
      logger.log(
        `${fgGreenColor}%s${resetColor}`,
        "If you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new."
      );
    }
    throw e;
  }
}

function getDevCompatibilityDate(
  config: Config,
  compatibilityDate = config.compatibility_date
) {
  const currentDate = new Date().toISOString().substring(0, 10);
  if (config.configPath !== undefined && compatibilityDate === undefined) {
    logger.warn(
      `No compatibility_date was specified. Using today's date: ${currentDate}.\n` +
        "Add one to your wrangler.toml file:\n" +
        "```\n" +
        `compatibility_date = "${currentDate}"\n` +
        "```\n" +
        "or pass it in your terminal:\n" +
        "```\n" +
        `--compatibility-date=${currentDate}\n` +
        "```\n" +
        "See https://developers.cloudflare.com/workers/platform/compatibility-dates for more information."
    );
  }
  return compatibilityDate ?? currentDate;
}
