import { errorInfo } from './types.ts';
import type { Node } from 'acorn';
// The policy walker visits heterogeneous Acorn nodes by property name.
type AstNode = Node & Record<string, any>;
import { parse } from 'acorn';

export const WXS_COMPILER_NAME = 'weapp-container-wxs';
export const WXS_COMPILER_VERSION = '1.0.0';
export const WXS_HELPER_ABI_VERSION = '1.0';

/**
 * Compile the admitted ECMAScript Script subset into the WXS property ABI.
 * This pass does not execute source, alter native prototypes or establish a
 * reflection sandbox. The caller supplies a lexical binding named `helper`.
 * Original source bytes must be retained separately from executable bytes.
 *
 * ABI 1.0:
 *   read(base, rawKey), callee(base, rawKey), invoke(record, argumentsArray)
 *   reference(base, rawKey), get(reference), set(reference, value, strict)
 *   update(reference, delta, prefix, strict), remove(base, rawKey, strict)
 *
 * `reference` stores raw values WITHOUT coercion or property access. Native
 * assignment defers key coercion until PutValue; compound/update operations
 * coerce the key separately at GetValue and PutValue. `callee` captures both
 * the function and receiver before arguments, while `invoke` checks and calls
 * that captured function only after all arguments have been evaluated.
 */
export function compileWxsModule(source: string) {
  source = requireSource(source);
  const program = parseSource(source);
  return compile(source, program);
}

/**
 * Compile one WXML expression. In template-data shorthand mode an expression
 * is attempted first; only a parse failure falls back to an object literal.
 * The returned code is an expression, never a function or `with` wrapper.
 * The host must bind `helper` INSIDE with(scope), in an inner lexical scope,
 * so even an all-intercepting scope Proxy cannot replace the ABI binding.
 */
export function compileWxmlExpression(source: string, { shorthand = false } = {}) {
  source = requireSource(source);
  let wrapped = `(${source}\n)`;
  let program;
  try {
    program = parseSource(wrapped);
  } catch (error) {
    if (!shorthand) throw error;
    wrapped = `({${source}\n})`;
    program = parseSource(wrapped);
  }
  if (program.body.length !== 1 || program.body[0].type !== 'ExpressionStatement') {
    throw unsupported(program, 'WXML requires one expression');
  }
  return compile(wrapped, program.body[0].expression);
}

function requireSource(source: unknown) {
  if (typeof source !== 'string') {
    const error = errorInfo(new TypeError('WXS source must be a string'));
    error.code = 'ERR_UNSUPPORTED_WXS_SYNTAX';
    throw error;
  }
  return source;
}

function parseSource(source: string) {
  try {
    return parse(source, {
      ecmaVersion: 2020,
      sourceType: 'script',
      preserveParens: true,
      locations: true,
      allowHashBang: false,
    });
  } catch (caught) {
    const cause = errorInfo(caught);
    const error = errorInfo(new SyntaxError(`Unsupported WXS syntax: ${cause.message}`, { cause }));
    error.code = 'ERR_UNSUPPORTED_WXS_SYNTAX';
    if (cause.loc) error.location = { line: cause.loc.line, column: cause.loc.column + 1 };
    throw error;
  }
}

function unsupported(node: AstNode, message: string) {
  const error = errorInfo(new SyntaxError(`Unsupported WXS syntax: ${message}`));
  error.code = 'ERR_UNSUPPORTED_WXS_SYNTAX';
  if (node.loc) error.location = { line: node.loc.start.line, column: node.loc.start.column + 1 };
  return error;
}

function children(node: AstNode): AstNode[] {
  const result = [];
  for (const [key, value] of Object.entries(node) as [string, any][]) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') result.push(child);
    } else if (value && typeof value.type === 'string') result.push(value);
  }
  return result;
}

function unwrap(node: AstNode): AstNode {
  while (node.type === 'ParenthesizedExpression') node = node.expression;
  return node;
}

function strictBody(body: AstNode[]) {
  for (const statement of body) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') return false;
    if (statement.directive === 'use strict') return true;
  }
  return false;
}

function compile(source: string, tree: AstNode) {
  const identifiers = new Set();
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'Identifier') identifiers.add(node.name);
    pending.push(...children(node));
  }
  let serial = 0;
  const fresh = () => {
    let name;
    do { name = `__wcWxs${serial++}`; } while (identifiers.has(name));
    identifiers.add(name);
    return name;
  };
  const helper = fresh();

  // Validate first, including syntax hidden inside an unvisited write target.
  const validate = (node: AstNode, parent?: AstNode, key?: string): void => {
    switch (node.type) {
      case 'WithStatement':
      case 'ImportExpression':
      case 'ChainExpression':
      case 'AwaitExpression':
      case 'YieldExpression':
      case 'TaggedTemplateExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
      case 'Super':
      case 'MetaProperty':
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'RestElement':
      case 'SpreadElement':
      case 'ForOfStatement':
        throw unsupported(node, `${node.type} is outside compiler ABI ${WXS_HELPER_ABI_VERSION}`);
      default:
        break;
    }
    if (node.async || node.generator || node.optional) {
      throw unsupported(node, 'async, generators and optional operations require a newer compiler ABI');
    }
    if (node.type === 'Identifier' && (node.name === 'eval' || node.name === 'Function')) {
      const propertyKey = (parent?.type === 'Property' && key === 'key' && !parent.computed)
        || (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed);
      const label = key === 'label' && ['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent?.type ?? '');
      if (!propertyKey && !label) throw unsupported(node, 'lexical eval and Function references are not admitted');
    }
    for (const [childKey, value] of Object.entries(node) as [string, any][]) {
      if (childKey === 'loc') continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') validate(child, node, childKey);
      } else if (value && typeof value.type === 'string') validate(value, node, childKey);
    }
  };
  validate(tree);

  const memberArgs = (node: AstNode, strict: boolean): string => `(${render(node.object, strict)}),${node.computed
    ? `(${render(node.property, strict)})` : JSON.stringify(node.property.name)}`;
  const reference = (node: AstNode, strict: boolean): string => `${helper}.reference(${memberArgs(node, strict)})`;
  const spliceChildren = (node: AstNode, strict: boolean): string => {
    const ordered = children(node).sort((a, b) => a.start - b.start || b.end - a.end);
    let cursor = node.start;
    let output = '';
    for (const child of ordered) {
      // Object shorthand keys/values share a range; render that range once.
      if (child.start < cursor) continue;
      output += source.slice(cursor, child.start);
      output += render(child, strict);
      cursor = child.end;
    }
    return output + source.slice(cursor, node.end);
  };
  const render = (node: AstNode, inheritedStrict: boolean): string => {
    let strict = inheritedStrict;
    if (node.type === 'Program') strict ||= strictBody(node.body);
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
        && node.body.type === 'BlockStatement') strict ||= strictBody(node.body.body);
    if (node.type === 'MemberExpression') return `(${helper}.read(${memberArgs(node, strict)}))`;
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee);
      if (callee.type === 'MemberExpression') {
        const args = node.arguments.map((argument: AstNode) => `(${render(argument, strict)})`).join(',');
        return `(${helper}.invoke(${helper}.callee(${memberArgs(callee, strict)}),[${args}]))`;
      }
    }
    if (node.type === 'NewExpression') {
      const args = node.arguments.map((argument: AstNode) => `(${render(argument, strict)})`).join(',');
      return `(new (${render(node.callee, strict)})(${args}))`;
    }
    if (node.type === 'AssignmentExpression') {
      const target = unwrap(node.left);
      if (target.type === 'MemberExpression') {
        const right = render(node.right, strict);
        if (node.operator === '=') return `(${helper}.set(${reference(target, strict)},(${right}),${strict}))`;
        const temporary = fresh();
        const operator = node.operator.slice(0, -1);
        return `((${temporary})=>${helper}.set(${temporary},(${helper}.get(${temporary}) ${operator} (${right})),${strict}))(${reference(target, strict)})`;
      }
    }
    if (node.type === 'UpdateExpression' && unwrap(node.argument).type === 'MemberExpression') {
      return `(${helper}.update(${reference(unwrap(node.argument), strict)},${node.operator === '++' ? 1 : -1},${node.prefix},${strict}))`;
    }
    if (node.type === 'UnaryExpression' && node.operator === 'delete'
        && unwrap(node.argument).type === 'MemberExpression') {
      return `(${helper}.remove(${memberArgs(unwrap(node.argument), strict)},${strict}))`;
    }
    if (node.type === 'ForInStatement' && unwrap(node.left).type === 'MemberExpression') {
      const key = fresh();
      const assigned = fresh();
      // Keep the iteration statement itself in place for labeled continue.
      // A declaration has empty completion, unlike an inserted expression
      // statement, so an empty original body keeps its native completion.
      return `for(let ${key} in (${render(node.right, strict)})){let ${assigned}=${helper}.set(${reference(unwrap(node.left), strict)},${key},${strict});${render(node.body, strict)}}`;
    }
    return spliceChildren(node, strict);
  };

  return { code: render(tree, false), helper };
}
