#!/usr/bin/env node
// Local checks only. Project modules are parsed, never evaluated or imported.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const runtimeRoot = path.join(projectRoot, 'tgcloud');
const errors = [];
const files = [];
const requiredHandlers = ['message', 'callback_query', 'my_chat_member'];
const allowedSdkImports = new Set(['sdk', 'sdk/db']);
const relativeName = (file) => path.relative(projectRoot, file).split(path.sep).join('/');
const report = (file, message) => errors.push(`${relativeName(file)}: ${message}`);

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      report(file, 'symbolic links are not allowed in the deployable module tree');
    } else if (entry.isDirectory()) {
      walk(file);
    } else if (entry.isFile() && file.endsWith('.js')) {
      files.push(file);
    } else if (entry.isFile() && /\.(?:mjs|cjs|ts|tsx|jsx)$/.test(file)) {
      report(file, 'runtime source must be a .js ES module; this file is not deployed');
    }
  }
}

// Read code tokens, skipping comments, strings and regular expressions, and
// visiting ${...} inside template strings. Module specifiers themselves are
// decoded by V8 below; this small scanner only detects dynamic import/default.
function codeTokens(source) {
  const result = [];
  let position = 0;
  const regexAfterWord = new Set([
    'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof',
    'in', 'of', 'new', 'yield', 'await', 'else', 'do',
  ]);
  const controlWords = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);

  function quoted(quote) {
    position++;
    while (position < source.length) {
      if (source[position] === '\\') position += 2;
      else if (source[position++] === quote) return;
    }
  }

  function template() {
    position++;
    while (position < source.length) {
      if (source[position] === '\\') position += 2;
      else if (source[position] === '`') { position++; return; }
      else if (source[position] === '$' && source[position + 1] === '{') {
        position += 2;
        code(true);
      } else position++;
    }
  }

  function regularExpression() {
    position++;
    let characterClass = false;
    while (position < source.length) {
      const char = source[position++];
      if (char === '\\') position++;
      else if (char === '[') characterClass = true;
      else if (char === ']') characterClass = false;
      else if (char === '/' && !characterClass) break;
    }
    while (/[a-z]/i.test(source[position] || '')) position++;
  }

  function code(inTemplate = false) {
    let braces = 0;
    let previous = '';
    let regexAllowed = true;
    const parentheses = [];
    while (position < source.length) {
      const char = source[position];
      if (/\s/.test(char)) { position++; continue; }
      if (source.startsWith('//', position)) {
        const end = source.indexOf('\n', position + 2);
        position = end < 0 ? source.length : end;
        continue;
      }
      if (source.startsWith('/*', position)) {
        const end = source.indexOf('*/', position + 2);
        position = end < 0 ? source.length : end + 2;
        continue;
      }
      if (char === '"' || char === "'") {
        quoted(char); previous = 'literal'; regexAllowed = false; continue;
      }
      if (char === '`') {
        template(); previous = 'literal'; regexAllowed = false; continue;
      }
      if (char === '/' && regexAllowed) {
        regularExpression(); previous = 'literal'; regexAllowed = false; continue;
      }
      if (/[\p{ID_Start}$_]/u.test(char)) {
        const start = position++;
        while (position < source.length && /[\p{ID_Continue}$\u200c\u200d]/u.test(source[position])) position++;
        const word = source.slice(start, position);
        result.push(word);
        previous = word;
        regexAllowed = regexAfterWord.has(word);
        continue;
      }
      if (/\d/.test(char)) {
        position++;
        while (position < source.length && /[\w.]/.test(source[position])) position++;
        previous = 'literal'; regexAllowed = false; continue;
      }
      position++;
      if (char === '}' && inTemplate && braces === 0) return;
      result.push(char);
      if (char === '{') braces++;
      if (char === '}') braces--;
      if (char === '(') parentheses.push(controlWords.has(previous));
      regexAllowed = char === ')' ? (parentheses.pop() ?? false) : ![']', '.'].includes(char);
      previous = char;
    }
  }

  code();
  return result;
}

if (!existsSync(runtimeRoot) || !lstatSync(runtimeRoot).isDirectory()) {
  report(runtimeRoot, 'missing tgcloud directory');
} else if (lstatSync(runtimeRoot).isSymbolicLink()) {
  report(runtimeRoot, 'tgcloud must not be a symbolic link');
} else {
  walk(runtimeRoot);
}

const knownFiles = new Set(files);
if (!knownFiles.has(path.join(runtimeRoot, 'schema.js'))) {
  report(path.join(runtimeRoot, 'schema.js'), 'missing schema module');
}
for (const name of requiredHandlers) {
  const file = path.join(runtimeRoot, 'handlers', `${name}.js`);
  if (!knownFiles.has(file)) report(file, 'missing required handler');
}

const modules = [];
for (const file of files.sort()) {
  const relative = path.relative(runtimeRoot, file).split(path.sep).join('/');
  if (relative !== 'schema.js' && !/^(?:handlers\/[^/]+\.js|endpoints\/[^/]+\.js|lib\/.+\.js)$/.test(relative)) {
    report(file, 'module must be schema.js or live under handlers/, endpoints/ or lib/; handlers/endpoints are flat');
  }
  if (relative.split('/').some((part) => part.startsWith('.'))) {
    report(file, 'hidden files and directories are not deployed');
  }

  const source = readFileSync(file, 'utf8');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (syntax.error || syntax.status !== 0) {
    report(file, `syntax check failed\n${syntax.error?.message || syntax.stderr.trim()}`);
    continue;
  }

  const tokens = codeTokens(source);
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === 'import' && tokens[index + 1] === '(' && tokens[index - 1] !== '.') {
      report(file, 'dynamic import() is not supported; use a static relative .js import');
    }
    if (tokens[index] === 'require' && tokens[index + 1] === '(') {
      report(file, 'CommonJS require() is not supported in Telegram Serverless');
    }
  }
  if (/^(?:handlers|endpoints)\//.test(relative) &&
      !tokens.some((token, index) => token === 'export' && tokens[index + 1] === 'default')) {
    report(file, 'entry points must use export default');
  }
  modules.push({ file, source });
}

// Use V8's parser for exact import/re-export specifiers, including escaped
// strings and multiline declarations. SourceTextModule construction does not
// evaluate code, link modules, contact the network or invoke the SDK.
if (modules.length) {
  const parserSource = `
    import { readFileSync } from 'node:fs';
    import { SourceTextModule } from 'node:vm';
    const modules = JSON.parse(readFileSync(0, 'utf8'));
    const output = modules.map(({file, source}) => ({
      file, imports: new SourceTextModule(source, {identifier: file}).dependencySpecifiers
    }));
    process.stdout.write(JSON.stringify(output));
  `;
  const parsed = spawnSync(process.execPath, [
    '--no-warnings', '--experimental-vm-modules', '--input-type=module', '-e', parserSource,
  ], { input: JSON.stringify(modules), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

  if (parsed.error || parsed.status !== 0) {
    report(runtimeRoot, `import parser failed\n${parsed.error?.message || parsed.stderr.trim()}`);
  } else {
    for (const { file, imports } of JSON.parse(parsed.stdout)) {
      for (const specifier of imports) {
        if (allowedSdkImports.has(specifier)) continue;
        if (!/^(?:\.\/|\.\.\/)/.test(specifier) || !specifier.endsWith('.js') || specifier.includes('\\')) {
          report(file, `unsupported import ${JSON.stringify(specifier)}; allowed: sdk, sdk/db, relative .js modules`);
          continue;
        }
        const target = path.resolve(path.dirname(file), specifier);
        const relative = path.relative(runtimeRoot, target);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          report(file, `import ${JSON.stringify(specifier)} leaves tgcloud/`);
        } else if (!knownFiles.has(target)) {
          report(file, `import ${JSON.stringify(specifier)} does not resolve to a deployed .js file`);
        }
      }
    }
  }
}

if (errors.length) {
  console.error(`Project check failed (${errors.length}):\n\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Static checks passed: ${files.length} JavaScript modules; required handlers and all imports verified.`);
  console.log('This checks syntax and module compatibility only; it does not run the Telegram SDK or deploy the bot.');
}
