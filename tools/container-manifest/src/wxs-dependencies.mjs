import { parse } from 'acorn';

/**
 * This is a static graph grammar, not the official WXS language validator.
 * Acorn parses ECMAScript 2020 Script syntax so division, regex literals,
 * escaped identifiers and executable template substitutions are distinguished
 * by grammar rather than token heuristics. A separate policy admits only
 * direct require calls with one string literal and rejects require rebinding
 * or other lexical uses, plus eval/Function/with/import graph indirection.
 *
 * No source is executed or transformed. Arbitrary JavaScript reflection is
 * not proven safe by this analysis: runtime declared-dependency checks remain
 * the loading boundary, and passing this pass does not imply WXS parity or a
 * security sandbox.
 */
export function extractWxsDependencySpecifiers(source) {
  let program;
  try {
    program = parse(source, {
      ecmaVersion: 2020,
      sourceType: 'script',
      locations: true,
      allowHashBang: false,
    });
  } catch (error) {
    return {
      specifiers: [],
      diagnostics: [{
        code: 'ERR_INVALID_WXS_SOURCE',
        message: `Invalid ECMAScript 2020 WXS graph syntax: ${error.message}`,
        ...(error.loc ? { location: { line: error.loc.line, column: error.loc.column + 1 } } : {}),
      }],
    };
  }

  const specifiers = new Set();
  const diagnostics = [];
  const report = (node, code, message) => diagnostics.push({
    code,
    message,
    location: { line: node.loc.start.line, column: node.loc.start.column + 1 },
  });
  const pending = [{ node: program, directRequire: false }];
  while (pending.length) {
    const { node, directRequire } = pending.pop();
    if (node.type === 'Identifier') {
      if (node.name === 'require' && !directRequire) {
        report(node, 'ERR_INVALID_WXS_DEPENDENCY', 'WXS require must be a direct call with one static relative .wxs string; aliases, rebinding and free references are unsupported');
      } else if (node.name === 'eval' || node.name === 'Function') {
        report(node, 'ERR_UNSUPPORTED_WXS_SYNTAX', 'WXS graph extraction cannot validate eval or Function references');
      }
      continue;
    }
    if (node.type === 'WithStatement' || node.type === 'ImportExpression') {
      report(node, 'ERR_UNSUPPORTED_WXS_SYNTAX', 'WXS graph extraction cannot validate with statements or dynamic import');
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      const argument = node.arguments[0];
      if (node.optional || node.arguments.length !== 1 || argument?.type !== 'Literal'
          || typeof argument.value !== 'string') {
        report(node, 'ERR_INVALID_WXS_DEPENDENCY', 'WXS require must use one static relative .wxs string literal without optional calls, spread or extra arguments');
      } else if (hasLegacyDigitEscape(argument.raw)) {
        report(argument, 'ERR_INVALID_WXS_DEPENDENCY', 'Legacy digit escapes are unsupported in WXS require paths');
      } else {
        specifiers.add(argument.value);
      }
    }

    // Property names and labels are not lexical binding references. Computed
    // keys and shorthand property values are expressions and must be visited.
    for (const [key, value] of Object.entries(node)) {
      if ((node.type === 'Property' || node.type === 'MethodDefinition') && key === 'key' && !node.computed) continue;
      if (node.type === 'MemberExpression' && key === 'property' && !node.computed) continue;
      if ((node.type === 'LabeledStatement' || node.type === 'BreakStatement' || node.type === 'ContinueStatement') && key === 'label') continue;
      const enqueue = child => {
        if (child && typeof child === 'object' && typeof child.type === 'string') {
          pending.push({
            node: child,
            directRequire: node.type === 'CallExpression' && key === 'callee'
              && child.type === 'Identifier' && child.name === 'require',
          });
        }
      };
      if (Array.isArray(value)) value.forEach(enqueue);
      else enqueue(value);
    }
  }
  diagnostics.sort((a, b) => a.location.line - b.location.line || a.location.column - b.location.column
    || Buffer.compare(Buffer.from(a.code), Buffer.from(b.code)));
  // A rejected graph has no valid completeness claim; packaging fails on the
  // diagnostics rather than publishing a seemingly complete partial graph.
  return {
    specifiers: diagnostics.length ? [] : [...specifiers].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    diagnostics,
  };
}

// Acorn decodes Unicode/hex escapes. Keep legacy decimal/octal escapes out of
// paths because their acceptance differs between strict and sloppy engines.
function hasLegacyDigitEscape(raw) {
  for (let index = 1; index < raw.length - 1; index += 1) {
    if (raw[index] !== '\\') continue;
    const escape = raw[++index];
    if (/[0-9]/.test(escape)) return true;
  }
  return false;
}
