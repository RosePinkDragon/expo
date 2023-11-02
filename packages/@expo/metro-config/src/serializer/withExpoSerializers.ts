/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { transformFromAstSync, traverse } from '@babel/core';
import { isJscSafeUrl, toNormalUrl } from 'jsc-safe-url';
import { Module, MixedOutput, ReadOnlyGraph, SerializerOptions } from 'metro';
import baseJSBundle from 'metro/src/DeltaBundler/Serializers/baseJSBundle';
// @ts-expect-error
import sourceMapString from 'metro/src/DeltaBundler/Serializers/sourceMapString';
import bundleToString from 'metro/src/lib/bundleToString';
import { InputConfigT, SerializerConfigT } from 'metro-config';
import path from 'path';

import { toFixture } from './__tests__/fixtures/toFixture';
import {
  serverPreludeSerializerPlugin,
  environmentVariableSerializerPlugin,
} from './environmentVariableSerializerPlugin';
import { fileNameFromContents, getCssSerialAssets } from './getCssDeps';
import { SerialAsset } from './serializerAssets';
import { env } from '../env';

const countLines = require('metro/src/lib/countLines');
import { MetroSourceMapSegmentTuple, functionMapBabelPlugin } from 'metro-source-map';
import * as babylon from '@babel/parser';

export type Serializer = NonNullable<SerializerConfigT['customSerializer']>;

export type SerializerParameters = Parameters<Serializer>;

// A serializer that processes the input and returns a modified version.
// Unlike a serializer, these can be chained together.
export type SerializerPlugin = (...props: SerializerParameters) => SerializerParameters;

export function withExpoSerializers(config: InputConfigT): InputConfigT {
  const processors: SerializerPlugin[] = [];
  processors.push(serverPreludeSerializerPlugin);
  if (!env.EXPO_NO_CLIENT_ENV_VARS) {
    processors.push(environmentVariableSerializerPlugin);
  }
  if (env.EXPO_USE_TREE_SHAKING) {
    processors.push(treeShakeSerializerPlugin);
  }

  return withSerializerPlugins(config, processors);
}

// There can only be one custom serializer as the input doesn't match the output.
// Here we simply run
export function withSerializerPlugins(
  config: InputConfigT,
  processors: SerializerPlugin[]
): InputConfigT {
  const originalSerializer = config.serializer?.customSerializer;

  return {
    ...config,
    serializer: {
      ...config.serializer,
      customSerializer: createSerializerFromSerialProcessors(processors, originalSerializer),
    },
  };
}
const JsFileWrapping = require('metro/src/ModuleGraph/worker/JsFileWrapping');
const generateImportNames = require('metro/src/ModuleGraph/worker/generateImportNames');

const inspect = (...props) =>
  console.log(...props.map((prop) => require('util').inspect(prop, { depth: 20, colors: true })));

export function treeShakeSerializerPlugin(
  entryPoint: string,
  preModules: readonly Module<MixedOutput>[],
  graph: ReadOnlyGraph,
  options: SerializerOptions
): SerializerParameters {
  const includeDebugInfo = false;
  const preserveEsm = false;

  // TODO: When we can reuse transformJS for JSON, we should not derive `minify` separately.
  const minify =
    graph.transformOptions.minify &&
    graph.transformOptions.unstable_transformProfile !== 'hermes-canary' &&
    graph.transformOptions.unstable_transformProfile !== 'hermes-stable';

  function collectImportExports(value: Module<MixedOutput>) {
    function getGraphId(moduleId: string) {
      const key = [...value.dependencies.values()].find((dep) => {
        return dep.data.name === moduleId;
      })?.absolutePath;

      if (!key) {
        throw new Error(
          `Failed to find graph key for import "${moduleId}" in module "${value.path}"`
        );
      }
      return key;
    }
    for (const index in value.output) {
      const outputItem = value.output[index];

      const ast =
        outputItem.data.ast ?? babylon.parse(outputItem.data.code, { sourceType: 'unambiguous' });

      outputItem.data.ast = ast;
      outputItem.data.modules = {
        imports: [],
        exports: [],
      };

      traverse(ast, {
        // Traverse and collect import/export statements.
        ImportDeclaration(path) {
          const source = path.node.source.value;
          const specifiers = path.node.specifiers.map((specifier) => {
            return {
              type: specifier.type,
              importedName: specifier.type === 'ImportSpecifier' ? specifier.imported.name : null,
              localName: specifier.local.name,
            };
          });

          outputItem.data.modules.imports.push({
            source,
            key: getGraphId(source),
            specifiers,
          });
        },
        // Track require calls
        CallExpression(path) {
          if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'require') {
            const arg = path.node.arguments[0];
            if (arg.type === 'StringLiteral') {
              outputItem.data.modules.imports.push({
                source: arg.value,
                key: getGraphId(arg.value),
                specifiers: [],
                cjs: true,
              });
            }
          }
        },
      });
    }
  }

  const detectCommonJsExportsUsage = (ast: Parameters<typeof traverse>[0]): boolean => {
    let usesCommonJsExports = false;

    traverse(ast, {
      MemberExpression(path) {
        if (
          (path.node.object.name === 'module' && path.node.property.name === 'exports') ||
          path.node.object.name === 'exports'
        ) {
          usesCommonJsExports = true;
          console.log(`Found usage of ${path.node.object.name}.${path.node.property.name}`);
        }
      },
      CallExpression(path) {
        // Check for Object.assign or Object.defineProperties
        if (
          path.node.callee.type === 'MemberExpression' &&
          path.node.callee.object.name === 'Object' &&
          (path.node.callee.property.name === 'assign' ||
            path.node.callee.property.name === 'defineProperties')
        ) {
          // Check if the first argument is module.exports
          const firstArg = path.node.arguments[0];
          if (
            firstArg.type === 'MemberExpression' &&
            firstArg.object.name === 'module' &&
            firstArg.property.name === 'exports'
          ) {
            usesCommonJsExports = true;
          } else if (firstArg.type === 'Identifier' && firstArg.name === 'exports') {
            usesCommonJsExports = true;
          }
        }
      },
    });

    return usesCommonJsExports;
  };

  function treeShakeExports(depId: string, value: Module<MixedOutput>) {
    const inverseDeps = [...value.inverseDependencies.values()].map((id) => {
      return graph.dependencies.get(id);
    });

    const isExportUsed = (importName: string) => {
      return inverseDeps.some((dep) => {
        return dep?.output.some((outputItem) => {
          if (outputItem.type === 'js/module') {
            const imports = outputItem.data.modules?.imports;
            if (imports) {
              return imports.some((importItem) => {
                return (
                  importItem.key === depId &&
                  // If the import is CommonJS, then we can't tree-shake it.
                  (importItem.cjs ||
                    importItem.specifiers.some((specifier) => {
                      return specifier.importedName === importName;
                    }))
                );
              });
            }
          }
          return false;
        });
      });
    };

    for (const index in value.output) {
      const outputItem = value.output[index];

      const ast = outputItem.data.ast;

      const annotate = false;

      function markUnused(path, node) {
        if (annotate) {
          node.leadingComments = node.leadingComments ?? [];
          node.leadingComments.push({
            type: 'CommentBlock',
            value: ` unused export ${node.id.name} `,
          });
        } else {
          path.remove();
        }
      }

      const remainingExports = new Set();

      // Traverse exports and mark them as used or unused based on if inverse dependencies are importing them.
      traverse(ast, {
        ExportDefaultDeclaration(path) {
          if (!isExportUsed('default')) {
            markUnused(path, path.node);
          } else {
            remainingExports.add('default');
          }
        },
        ExportNamedDeclaration(path) {
          const declaration = path.node.declaration;
          if (declaration) {
            if (declaration.type === 'VariableDeclaration') {
              declaration.declarations.forEach((decl) => {
                if (decl.id.type === 'Identifier') {
                  if (!isExportUsed(decl.id.name)) {
                    markUnused(path, decl);
                  } else {
                    remainingExports.add(decl.id.name);
                  }
                }
              });
            } else {
              // if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration')
              if (!isExportUsed(declaration.id.name)) {
                markUnused(path, declaration);
              } else {
                remainingExports.add(declaration.id.name);
              }
            }
          }
        },
      });
    }
  }

  function removeUnusedImports(value: Module<MixedOutput>, ast: Parameters<typeof traverse>[0]) {
    // Traverse imports and remove unused imports.

    // Keep track of all the imported identifiers
    const importedIdentifiers = new Set();

    // Keep track of all used identifiers
    const usedIdentifiers = new Set();

    traverse(ast, {
      ImportSpecifier(path) {
        importedIdentifiers.add(path.node.imported.name);
      },
      ImportDefaultSpecifier(path) {
        importedIdentifiers.add(path.node.local.name);
      },
      ImportNamespaceSpecifier(path) {
        importedIdentifiers.add(path.node.local.name);
      },
      Identifier(path) {
        // Make sure this identifier isn't coming from an import specifier
        if (path.findParent((path) => path.isImportSpecifier())) {
          return;
        }
        if (!path.scope.bindingIdentifierEquals(path.node.name, path.node)) {
          usedIdentifiers.add(path.node.name);
        }
      },
    });

    // Determine unused identifiers by subtracting the used from the imported
    const unusedImports = [...importedIdentifiers].filter(
      (identifier) => !usedIdentifiers.has(identifier)
    );

    // console.log('usedIdentifiers', unusedImports, usedIdentifiers);

    let removed = unusedImports.length > 0;
    // Remove the unused imports from the AST
    traverse(ast, {
      ImportDeclaration(path) {
        path.node.specifiers = path.node.specifiers.filter((specifier) => {
          return !unusedImports.includes(specifier.imported.name);
        });

        // If no specifiers are left after filtering, remove the whole import declaration
        // e.g. `import './unused'` or `import {} from './unused'` -> remove.
        if (path.node.specifiers.length === 0) {
          // TODO: Ensure the module isn't side-effect-ful or importing a module that is side-effect-ful.
          const importModuleId = path.node.source.value;
          // Unlink the module in the graph
          const depId = [...value.dependencies.entries()].find(([key, dep]) => {
            return dep.data.name === importModuleId;
          })?.[0];

          // Should never happen but we're playing with fire here.
          if (!depId) {
            throw new Error(
              `Failed to find graph key for import "${importModuleId}" from "${importModuleId}"`
            );
          }

          const dep = value.dependencies.get(depId)!;

          const graphDep = graph.dependencies.get(dep.absolutePath);

          // Remove inverse link to this dependency
          graphDep!.inverseDependencies.delete(value.path);

          if (graphDep!.inverseDependencies.size === 0) {
            // Remove the dependency from the graph as no other modules are using it anymore.
            graph.dependencies.delete(dep.absolutePath);
          }

          // Remove dependency from this module in the graph
          value.dependencies.delete(depId);

          // Delete the AST
          path.remove();
          removed = true;
        }
      },
    });

    return removed;
  }

  function treeShakeAll() {
    // This pass will parse all modules back to AST and include the import/export statements.
    for (const value of graph.dependencies.values()) {
      collectImportExports(value);
    }

    // This pass will annotate the AST with the used and unused exports.
    for (const [depId, value] of graph.dependencies.entries()) {
      treeShakeExports(depId, value);

      for (const index in value.output) {
        const outputItem = value.output[index];

        const ast = outputItem.data.ast;

        if (removeUnusedImports(value, ast)) {
          // TODO: haha this is slow
          treeShakeAll();
        }
      }
    }
  }

  treeShakeAll();

  for (const value of graph.dependencies.values()) {
    // console.log('inverseDependencies', value.inverseDependencies.values());

    for (const index in value.output) {
      const outputItem = value.output[index];
      // inspect('ii', outputItem.data.modules.imports);

      // let ast = outputItem.data.ast!;
      let ast = outputItem.data.ast; //?? babylon.parse(outputItem.data.code, { sourceType: 'unambiguous' });

      const { importDefault, importAll } = generateImportNames(ast);

      const babelPluginOpts = {
        // ...options,
        inlineableCalls: [importDefault, importAll],
        importDefault,
        importAll,
      };

      ast = transformFromAstSync(ast, undefined, {
        ast: true,
        babelrc: false,
        code: false,
        configFile: false,
        comments: includeDebugInfo,
        compact: false,

        filename: value.path,
        plugins: [
          functionMapBabelPlugin,
          !preserveEsm && [
            require('metro-transform-plugins/src/import-export-plugin'),
            babelPluginOpts,
          ],
          !preserveEsm && [require('metro-transform-plugins/src/inline-plugin'), babelPluginOpts],
        ].filter(Boolean),
        sourceMaps: false,
        // Not-Cloning the input AST here should be safe because other code paths above this call
        // are mutating the AST as well and no code is depending on the original AST.
        // However, switching the flag to false caused issues with ES Modules if `experimentalImportSupport` isn't used https://github.com/facebook/metro/issues/641
        // either because one of the plugins is doing something funky or Babel messes up some caches.
        // Make sure to test the above mentioned case before flipping the flag back to false.
        cloneInputAst: true,
      })?.ast!;

      const dependencyMapName = '';
      const globalPrefix = '';

      const { ast: wrappedAst } = JsFileWrapping.wrapModule(
        ast,
        importDefault,
        importAll,
        dependencyMapName,
        globalPrefix
      );

      const outputCode = transformFromAstSync(wrappedAst, undefined, {
        ast: false,
        babelrc: false,
        code: true,
        configFile: false,

        // comments: true,
        // compact: false,

        comments: includeDebugInfo,
        compact: !includeDebugInfo,

        filename: value.path,
        plugins: [],
        sourceMaps: false,
        // Not-Cloning the input AST here should be safe because other code paths above this call
        // are mutating the AST as well and no code is depending on the original AST.
        // However, switching the flag to false caused issues with ES Modules if `experimentalImportSupport` isn't used https://github.com/facebook/metro/issues/641
        // either because one of the plugins is doing something funky or Babel messes up some caches.
        // Make sure to test the above mentioned case before flipping the flag back to false.
        cloneInputAst: true,
      })!.code!;

      let map: Array<MetroSourceMapSegmentTuple> = [];

      if (minify) {
        // ({ map, code } = await minifyCode(
        //   config,
        //   projectRoot,
        //   file.filename,
        //   code,
        //   file.code,
        //   map
        // ));
      }

      outputItem.data.code = (includeDebugInfo ? `\n// ${value.path}\n` : '') + outputCode;
      outputItem.data.lineCount = countLines(outputItem.data.code);
      outputItem.data.map = map;
      outputItem.data.functionMap =
        ast.metadata?.metro?.functionMap ??
        // Fallback to deprecated explicitly-generated `functionMap`
        ast.functionMap ??
        null;
      // TODO: minify the code to fold anything that was dropped above.

      // console.log('output code', outputItem.data.code);
    }
  }

  // console.log(
  //   require('util').inspect({ entryPoint, graph, options }, { depth: 20, colors: true })
  // );

  return [entryPoint, preModules, graph, options];
}

export function getDefaultSerializer(fallbackSerializer?: Serializer | null): Serializer {
  const defaultSerializer =
    fallbackSerializer ??
    (async (...params: SerializerParameters) => {
      const bundle = baseJSBundle(...params);
      const outputCode = bundleToString(bundle).code;
      return outputCode;
    });
  return async (
    ...props: SerializerParameters
  ): Promise<string | { code: string; map: string }> => {
    const [entryPoint, preModules, graph, options] = props;

    // toFixture(...props);

    const jsCode = await defaultSerializer(entryPoint, preModules, graph, options);

    // console.log('OUTPUT CODE', jsCode);

    if (!options.sourceUrl) {
      return jsCode;
    }
    const sourceUrl = isJscSafeUrl(options.sourceUrl)
      ? toNormalUrl(options.sourceUrl)
      : options.sourceUrl;
    const url = new URL(sourceUrl, 'https://expo.dev');
    if (
      url.searchParams.get('platform') !== 'web' ||
      url.searchParams.get('serializer.output') !== 'static'
    ) {
      // Default behavior if `serializer.output=static` is not present in the URL.
      return jsCode;
    }

    const includeSourceMaps = url.searchParams.get('serializer.map') === 'true';

    const cssDeps = getCssSerialAssets<MixedOutput>(graph.dependencies, {
      projectRoot: options.projectRoot,
      processModuleFilter: options.processModuleFilter,
    });

    const jsAssets: SerialAsset[] = [];

    if (jsCode) {
      const stringContents = typeof jsCode === 'string' ? jsCode : jsCode.code;
      const jsFilename = fileNameFromContents({
        filepath: url.pathname,
        src: stringContents,
      });
      jsAssets.push({
        filename: options.dev ? 'index.js' : `_expo/static/js/web/${jsFilename}.js`,
        originFilename: 'index.js',
        type: 'js',
        metadata: {},
        source: stringContents,
      });

      if (
        // Only include the source map if the `options.sourceMapUrl` option is provided and we are exporting a static build.
        includeSourceMaps &&
        options.sourceMapUrl
      ) {
        const sourceMap = typeof jsCode === 'string' ? serializeToSourceMap(...props) : jsCode.map;

        // Make all paths relative to the server root to prevent the entire user filesystem from being exposed.
        const parsed = JSON.parse(sourceMap);
        // TODO: Maybe we can do this earlier.
        parsed.sources = parsed.sources.map(
          // TODO: Maybe basePath support
          (value: string) => {
            if (value.startsWith('/')) {
              return '/' + path.relative(options.serverRoot ?? options.projectRoot, value);
            }
            // Prevent `__prelude__` from being relative.
            return value;
          }
        );

        jsAssets.push({
          filename: options.dev ? 'index.map' : `_expo/static/js/web/${jsFilename}.js.map`,
          originFilename: 'index.map',
          type: 'map',
          metadata: {},
          source: JSON.stringify(parsed),
        });
      }
    }

    return JSON.stringify([...jsAssets, ...cssDeps]);
  };
}

function getSortedModules(
  graph: SerializerParameters[2],
  {
    createModuleId,
  }: {
    createModuleId: (path: string) => number;
  }
): readonly Module<any>[] {
  const modules = [...graph.dependencies.values()];
  // Assign IDs to modules in a consistent order
  for (const module of modules) {
    createModuleId(module.path);
  }
  // Sort by IDs
  return modules.sort(
    (a: Module<any>, b: Module<any>) => createModuleId(a.path) - createModuleId(b.path)
  );
}

function serializeToSourceMap(...props: SerializerParameters): string {
  const [, prepend, graph, options] = props;

  const modules = [
    ...prepend,
    ...getSortedModules(graph, {
      createModuleId: options.createModuleId,
    }),
  ];

  return sourceMapString(modules, {
    ...options,
  });
}

export function createSerializerFromSerialProcessors(
  processors: (SerializerPlugin | undefined)[],
  originalSerializer?: Serializer | null
): Serializer {
  const finalSerializer = getDefaultSerializer(originalSerializer);
  return (...props: SerializerParameters): ReturnType<Serializer> => {
    for (const processor of processors) {
      if (processor) {
        props = processor(...props);
      }
    }

    return finalSerializer(...props);
  };
}

export { SerialAsset };
