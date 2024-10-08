import fs from 'node:fs';
import path, { dirname, extname, isAbsolute, join } from 'node:path';
import {
  type RsbuildConfig,
  type RsbuildInstance,
  createRsbuild,
  defineConfig as defineRsbuildConfig,
  loadConfig as loadRsbuildConfig,
  mergeRsbuildConfig,
} from '@rsbuild/core';
import glob from 'fast-glob';
import { DEFAULT_CONFIG_NAME, DEFAULT_EXTENSIONS } from './constant';
import type {
  AutoExternal,
  Format,
  LibConfig,
  PkgJson,
  RslibConfig,
  RslibConfigAsyncFn,
  RslibConfigExport,
  RslibConfigSyncFn,
  Syntax,
} from './types';
import { getDefaultExtension } from './utils/extension';
import {
  calcLongestCommonPath,
  color,
  isObject,
  nodeBuiltInModules,
  omitDeep,
  readPackageJson,
} from './utils/helper';
import { logger } from './utils/logger';
import { transformSyntaxToBrowserslist } from './utils/syntax';

/**
 * This function helps you to autocomplete configuration types.
 * It accepts a Rslib config object, or a function that returns a config.
 */
export function defineConfig(config: RslibConfig): RslibConfig;
export function defineConfig(config: RslibConfigSyncFn): RslibConfigSyncFn;
export function defineConfig(config: RslibConfigAsyncFn): RslibConfigAsyncFn;
export function defineConfig(config: RslibConfigExport): RslibConfigExport;
export function defineConfig(config: RslibConfigExport) {
  return config;
}

const findConfig = (basePath: string): string | undefined => {
  return DEFAULT_EXTENSIONS.map((ext) => basePath + ext).find(fs.existsSync);
};

const resolveConfigPath = (root: string, customConfig?: string): string => {
  if (customConfig) {
    const customConfigPath = isAbsolute(customConfig)
      ? customConfig
      : join(root, customConfig);
    if (fs.existsSync(customConfigPath)) {
      return customConfigPath;
    }
    logger.warn(`Cannot find config file: ${color.dim(customConfigPath)}\n`);
  }

  const configFilePath = findConfig(join(root, DEFAULT_CONFIG_NAME));

  if (configFilePath) {
    return configFilePath;
  }

  throw new Error(`${DEFAULT_CONFIG_NAME} not found in ${root}`);
};

export async function loadConfig({
  cwd = process.cwd(),
  path,
  envMode,
}: {
  cwd?: string;
  path?: string;
  envMode?: string;
}): Promise<RslibConfig> {
  const configFilePath = resolveConfigPath(cwd, path);
  const { content } = await loadRsbuildConfig({
    cwd: dirname(configFilePath),
    path: configFilePath,
    envMode,
  });

  return content as RslibConfig;
}

export const composeAutoExternalConfig = (options: {
  autoExternal: AutoExternal;
  pkgJson?: PkgJson;
  userExternals?: NonNullable<RsbuildConfig['output']>['externals'];
}): RsbuildConfig => {
  const { autoExternal, pkgJson, userExternals } = options;

  if (!autoExternal) {
    return {};
  }

  if (!pkgJson) {
    logger.warn(
      'autoExternal configuration will not be applied due to read package.json failed',
    );
    return {};
  }

  const externalOptions = {
    dependencies: true,
    peerDependencies: true,
    devDependencies: false,
    ...(autoExternal === true ? {} : autoExternal),
  };

  // User externals configuration has higher priority than autoExternal
  // eg: autoExternal: ['react'], user: output: { externals: { react: 'react-1' } }
  // Only handle the case where the externals type is object, string / string[] does not need to be processed, other types are too complex.
  const userExternalKeys =
    userExternals && isObject(userExternals) ? Object.keys(userExternals) : [];

  const externals = (
    ['dependencies', 'peerDependencies', 'devDependencies'] as const
  )
    .reduce<string[]>((prev, type) => {
      if (externalOptions[type]) {
        return pkgJson[type] ? prev.concat(Object.keys(pkgJson[type]!)) : prev;
      }
      return prev;
    }, [])
    .filter((name) => !userExternalKeys.includes(name));

  const uniqueExternals = Array.from(new Set(externals));

  return externals.length
    ? {
        output: {
          externals: [
            // Exclude dependencies, e.g. `react`, `react/jsx-runtime`
            ...uniqueExternals.map((dep) => new RegExp(`^${dep}($|\\/|\\\\)`)),
            ...uniqueExternals,
          ],
        },
      }
    : {};
};

export async function createInternalRsbuildConfig(): Promise<RsbuildConfig> {
  return defineRsbuildConfig({
    mode: 'production',
    dev: {
      progressBar: false,
    },
    tools: {
      htmlPlugin: false,
      rspack: {
        optimization: {
          moduleIds: 'named',
        },
        experiments: {
          rspackFuture: {
            bundlerInfo: {
              force: false,
            },
          },
        },
        // TypeScript-specific behavior: if the extension is ".js" or ".jsx", try replacing it with ".ts" or ".tsx"
        // see https://github.com/web-infra-dev/rslib/issues/41
        resolve: {
          extensionAlias: {
            '.js': ['.ts', '.tsx', '.js', '.jsx'],
            '.jsx': ['.tsx', '.jsx'],
            '.mjs': ['.mts', '.mjs'],
            '.cjs': ['.cts', '.cjs'],
          },
        },
      },
    },
    output: {
      filenameHash: false,
      minify: {
        js: true,
        css: false,
        jsOptions: {
          minimizerOptions: {
            mangle: false,
            minify: false,
            compress: {
              defaults: false,
              unused: true,
              dead_code: true,
              toplevel: true,
            },
            format: {
              comments: 'all',
            },
          },
        },
      },
      distPath: {
        js: './',
      },
    },
  });
}

const composeFormatConfig = (format: Format): RsbuildConfig => {
  switch (format) {
    case 'esm':
      return {
        tools: {
          rspack: {
            output: {
              module: true,
              chunkFormat: 'module',
              library: {
                type: 'modern-module',
              },
            },
            module: {
              parser: {
                javascript: {
                  importMeta: false,
                },
              },
            },
            optimization: {
              concatenateModules: true,
            },
            experiments: {
              outputModule: true,
            },
          },
        },
      };
    case 'cjs':
      return {
        tools: {
          rspack: {
            output: {
              iife: false,
              chunkFormat: 'commonjs',
              library: {
                type: 'commonjs',
              },
            },
          },
        },
      };
    case 'umd':
      return {
        tools: {
          rspack: {
            output: {
              library: {
                type: 'umd',
              },
            },
          },
        },
      };
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
};

export const composeModuleImportWarn = (request: string): string => {
  return `The externalized commonjs request ${color.green(`"${request}"`)} will use ${color.blue('"module"')} external type in ESM format. If you want to specify other external type, considering set the request and type with ${color.blue('"output.externals"')}.`;
};

const composeExternalsConfig = (
  format: Format,
  externals: NonNullable<RsbuildConfig['output']>['externals'],
): RsbuildConfig => {
  switch (format) {
    case 'esm': {
      const userExternals = Array.isArray(externals) ? externals : [externals];
      return {
        output: {
          // TODO: Define the internal externals config in Rsbuild's externals instead
          // Rspack's externals as they will not be merged from different fields. All externals
          // should to be unified and merged together in the future.
          // @ts-ignore
          externals: [
            ({ request, dependencyType }: any, callback: any) => {
              if (dependencyType === 'commonjs') {
                logger.warn(composeModuleImportWarn(request));
              }
              callback();
            },
            ...userExternals,
          ].filter(Boolean),
        },
        tools: {
          rspack: {
            externalsType: 'module-import',
          },
        },
      };
    }
    case 'cjs':
      return {
        output: externals
          ? {
              externals,
            }
          : {},
        tools: {
          rspack: {
            externalsType: 'commonjs',
          },
        },
      };
    case 'umd':
      return {
        output: externals
          ? {
              externals,
            }
          : {},
        tools: {
          rspack: {
            externalsType: 'umd',
          },
        },
      };
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
};

const composeAutoExtensionConfig = (
  config: LibConfig,
  autoExtension: boolean,
  pkgJson?: PkgJson,
): {
  config: RsbuildConfig;
  jsExtension: string;
  dtsExtension: string;
} => {
  const { jsExtension, dtsExtension } = getDefaultExtension({
    format: config.format!,
    pkgJson,
    autoExtension,
  });

  return {
    config: {
      output: {
        filename: {
          js: `[name]${jsExtension}`,
          ...config.output?.filename,
        },
      },
    },
    jsExtension,
    dtsExtension,
  };
};

const composeSyntaxConfig = (
  syntax?: Syntax,
  target?: string,
): RsbuildConfig => {
  // Defaults to ESNext, Rslib will assume all of the latest JavaScript and CSS features are supported.
  if (syntax) {
    return {
      tools: {
        rspack: (config) => {
          // TODO: Rspack should could resolve `browserslist:{query}` like webpack.
          // https://webpack.js.org/configuration/target/#browserslist
          // Using 'es5' as a temporary solution for compatibility.
          config.target = ['es5'];
          return config;
        },
      },
      output: {
        overrideBrowserslist: transformSyntaxToBrowserslist(syntax),
      },
    };
  }

  // If `syntax` is not defined, Rslib will try to determine by the `target`, with the last version of the target.
  const lastTargetVersions = {
    node: ['last 1 node versions'],
    web: [
      'last 1 Chrome versions',
      'last 1 Firefox versions',
      'last 1 Edge versions',
      'last 1 Safari versions',
      'last 1 ios_saf versions',
      'not dead',
    ],
  };

  return {
    tools: {
      rspack: (config) => {
        config.target = ['es2022'];
        return config;
      },
    },
    output: {
      overrideBrowserslist:
        target === 'web'
          ? lastTargetVersions.web
          : target === 'node'
            ? lastTargetVersions.node
            : [...lastTargetVersions.node, ...lastTargetVersions.web],
    },
  };
};

const composeEntryConfig = async (
  entries: NonNullable<RsbuildConfig['source']>['entry'],
  bundle: LibConfig['bundle'],
  root: string,
): Promise<RsbuildConfig> => {
  if (!entries) {
    return {};
  }

  if (bundle !== false) {
    return {
      source: {
        entry: entries,
      },
    };
  }

  // In bundleless mode, resolve glob patterns and convert them to entry object.
  const resolvedEntries: Record<string, string> = {};
  for (const key of Object.keys(entries)) {
    const entry = entries[key];

    // Entries in bundleless mode could be:
    // 1. A string of glob pattern: { entry: { index: 'src/*.ts' } }
    // 2. An array of glob patterns: { entry: { index: ['src/*.ts', 'src/*.tsx'] } }
    // Not supported for now: entry description object
    const entryFiles = Array.isArray(entry)
      ? entry
      : typeof entry === 'string'
        ? [entry]
        : null;

    if (!entryFiles) {
      throw new Error(
        'Entry can only be a string or an array of strings for now',
      );
    }

    // Turn entries in array into each separate entry.
    const resolvedEntryFiles = await glob(entryFiles, {
      cwd: root,
    });

    if (resolvedEntryFiles.length === 0) {
      throw new Error(`Cannot find ${resolvedEntryFiles}`);
    }

    // Similar to `rootDir` in tsconfig and `outbase` in esbuild.
    const lcp = await calcLongestCommonPath(resolvedEntryFiles);
    // Using the longest common path of all non-declaration input files by default.
    const outBase = lcp === null ? root : lcp;

    for (const file of resolvedEntryFiles) {
      const { dir, name } = path.parse(path.relative(outBase, file));
      // Entry filename contains nested path to preserve source directory structure.
      const entryFileName = path.join(dir, name);
      resolvedEntries[entryFileName] = file;
    }
  }

  return {
    source: {
      entry: resolvedEntries,
    },
  };
};

const composeBundleConfig = (
  jsExtension: string,
  bundle = true,
): RsbuildConfig => {
  if (bundle) return {};

  return {
    output: {
      externals: [
        (data: any, callback: any) => {
          // Issuer is not empty string when the module is imported by another module.
          // Prevent from externalizing entry modules here.
          if (data.contextInfo.issuer) {
            // Node.js ECMAScript module loader does no extension searching.
            // Add a file extension according to autoExtension config
            // when data.request is a relative path and do not have an extension.
            // If data.request already have an extension, we replace it with new extension
            // This may result in a change in semantics,
            // user should use copy to keep origin file or use another separate entry to deal this
            let request = data.request;
            if (request[0] === '.') {
              request = extname(request)
                ? request.replace(/\.[^.]+$/, jsExtension)
                : `${request}${jsExtension}`;
            }
            return callback(null, request);
          }
          callback();
        },
      ],
    },
  };
};

const composeDtsConfig = async (
  libConfig: LibConfig,
  dtsExtension: string,
): Promise<RsbuildConfig> => {
  const { dts, bundle, output, autoExternal } = libConfig;

  if (dts === false || dts === undefined) return {};

  const { pluginDts } = await import('rsbuild-plugin-dts');
  return {
    plugins: [
      pluginDts({
        bundle: dts?.bundle ?? bundle,
        distPath: dts?.distPath ?? output?.distPath?.root ?? './dist',
        abortOnError: dts?.abortOnError ?? true,
        dtsExtension,
        autoExternal,
      }),
    ],
  };
};

const composeTargetConfig = (target = 'web'): RsbuildConfig => {
  switch (target) {
    case 'web':
      return {
        tools: {
          rspack: {
            target: ['web'],
          },
        },
      };
    case 'node':
      return {
        tools: {
          rspack: {
            target: ['node'],
            // "__dirname" and "__filename" shims will automatically be enabled when `output.module` is `true`,
            // and leave them as-is in the rest of the cases.
            // { node: { __dirname: ..., __filename: ... } }
          },
        },
        output: {
          // When output.target is 'node', Node.js's built-in will be treated as externals of type `node-commonjs`.
          // Simply override the built-in modules to make them external.
          // https://github.com/webpack/webpack/blob/dd44b206a9c50f4b4cb4d134e1a0bd0387b159a3/lib/node/NodeTargetPlugin.js#L81
          externals: nodeBuiltInModules,
          target: 'node',
        },
      };
    case 'neutral':
      return {
        tools: {
          rspack: {
            target: ['web', 'node'],
          },
        },
      };
    default:
      throw new Error(`Unsupported platform: ${target}`);
  }
};

async function composeLibRsbuildConfig(config: LibConfig, configPath: string) {
  const rootPath = dirname(configPath);
  const pkgJson = readPackageJson(rootPath);

  const { format, autoExtension = true, autoExternal = true } = config;
  const formatConfig = composeFormatConfig(format!);
  const externalsConfig = composeExternalsConfig(
    format!,
    config.output?.externals,
  );
  const {
    config: autoExtensionConfig,
    jsExtension,
    dtsExtension,
  } = composeAutoExtensionConfig(config, autoExtension, pkgJson);
  const bundleConfig = composeBundleConfig(jsExtension, config.bundle);
  const targetConfig = composeTargetConfig(config.output?.target);
  const syntaxConfig = composeSyntaxConfig(
    config.output?.syntax,
    config.output?.target,
  );
  const autoExternalConfig = composeAutoExternalConfig({
    autoExternal,
    pkgJson,
    userExternals: config.output?.externals,
  });
  const entryConfig = await composeEntryConfig(
    config.source?.entry,
    config.bundle,
    dirname(configPath),
  );
  const dtsConfig = await composeDtsConfig(config, dtsExtension);

  return mergeRsbuildConfig(
    formatConfig,
    externalsConfig,
    autoExtensionConfig,
    autoExternalConfig,
    syntaxConfig,
    bundleConfig,
    targetConfig,
    entryConfig,
    dtsConfig,
  );
}

export async function composeCreateRsbuildConfig(
  rslibConfig: RslibConfig,
  path?: string,
): Promise<{ format: Format; config: RsbuildConfig }[]> {
  const internalRsbuildConfig = await createInternalRsbuildConfig();
  const configPath = path ?? rslibConfig._privateMeta?.configFilePath!;
  const { lib: libConfigsArray, ...sharedRsbuildConfig } = rslibConfig;

  if (!libConfigsArray) {
    throw new Error(
      `Expect lib field to be an array, but got ${libConfigsArray}.`,
    );
  }

  const libConfigPromises = libConfigsArray.map(async (libConfig) => {
    const userConfig = mergeRsbuildConfig<LibConfig>(
      sharedRsbuildConfig,
      libConfig,
    );

    // Merge the configuration of each environment based on the shared Rsbuild
    // configuration and Lib configuration in the settings.
    const libRsbuildConfig = await composeLibRsbuildConfig(
      userConfig,
      configPath,
    );

    // Reset certain fields because they will be completely overridden by the upcoming merge.
    // We don't want to retain them in the final configuration.
    // The reset process should occur after merging the library configuration.
    userConfig.source ??= {};
    userConfig.source.entry = {};

    // Already manually sort and merge the externals configuration.
    userConfig.output ??= {};
    delete userConfig.output.externals;

    return {
      format: libConfig.format!,
      // The merge order represents the priority of the configuration
      // The priorities from high to low are as follows:
      // 1 - userConfig: users can configure any Rsbuild and Rspack config
      // 2 - libRsbuildConfig: the configuration that we compose from Rslib unique config and userConfig from 1
      // 3 - internalRsbuildConfig: the built-in best practice Rsbuild configuration we provide in Rslib
      // We should state in the document that the built-in configuration should not be changed optionally
      // In compose process of 2, we may read some config from 1, and reassemble the related config,
      // so before final mergeRsbuildConfig, we reset some specified fields
      config: mergeRsbuildConfig(
        internalRsbuildConfig,
        libRsbuildConfig,
        omitDeep(userConfig, [
          'bundle',
          'format',
          'autoExtension',
          'autoExternal',
          'syntax',
          'dts',
        ]),
      ),
    };
  });

  const composedRsbuildConfig = await Promise.all(libConfigPromises);
  return composedRsbuildConfig;
}

export async function initRsbuild(
  rslibConfig: RslibConfig,
): Promise<RsbuildInstance> {
  const rsbuildConfigObject = await composeCreateRsbuildConfig(rslibConfig);
  const environments: RsbuildConfig['environments'] = {};
  const formatCount: Record<Format, number> = rsbuildConfigObject.reduce(
    (acc, { format }) => {
      acc[format] = (acc[format] ?? 0) + 1;
      return acc;
    },
    {} as Record<Format, number>,
  );

  const formatIndex: Record<Format, number> = {
    esm: 0,
    cjs: 0,
    umd: 0,
  };

  for (const { format, config } of rsbuildConfigObject) {
    const currentFormatCount = formatCount[format];
    const currentFormatIndex = formatIndex[format]++;

    environments[
      currentFormatCount === 1 ? format : `${format}${currentFormatIndex}`
    ] = config;
  }

  return createRsbuild({
    rsbuildConfig: {
      environments,
    },
  });
}
