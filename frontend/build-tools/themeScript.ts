import type { Plugin } from 'vite';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../src/theme/prepaint.ts', import.meta.url));

/** Transpiles the pre-paint theme script to a classic (non-module) script. */
export function compileThemeScript(source: string = readFileSync(SOURCE, 'utf8')): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.ESNext },
  }).outputText;
}

/** Emits /theme.js (classic script, loaded first in <head>) in build and serves it in dev. */
export function themeScript(): Plugin {
  return {
    name: 'message-poc-theme-script',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'theme.js', source: compileThemeScript() });
    },
    configureServer(server) {
      server.watcher.add(SOURCE);
      server.middlewares.use('/theme.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(compileThemeScript());
      });
    },
  };
}
