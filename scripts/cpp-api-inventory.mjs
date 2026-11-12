// Source inventory only. Runtime configuration still validates the catalog.
// Interpret the literal registration grammar used by the desktop adapters;
// never silently discard a registered name which the catalog does not know.
const apiPrefix = /^(?:wx\.|object:|component:|weappContainer\.)/;

function uncomment(source) {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    value => value.startsWith('//') || value.startsWith('/*') ? value.replace(/[^\n]/g, ' ') : value);
}

function closing(source, start, open, close) {
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < source.length; ++index) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === open) ++depth;
    else if (character === close && --depth === 0) return index;
  }
  throw new Error('Unterminated C++ API registration expression');
}

function statementEnd(source, start) {
  while (/\s/.test(source[start] ?? '') && start < source.length) ++start;
  if (source[start] === '{') return closing(source, start, '{', '}') + 1;
  let quoted = false, escaped = false;
  for (let index = start; index < source.length; ++index) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ';') return index + 1;
  }
  throw new Error('Unterminated C++ API registration statement');
}

function argumentsOf(source) {
  const result = []; let start = 0, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < source.length; ++index) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if ('([{'.includes(character)) ++depth;
    else if (')]}'.includes(character)) --depth;
    else if (character === ',' && depth === 0) { result.push(source.slice(start, index)); start = index + 1; }
  }
  result.push(source.slice(start)); return result;
}

function literalExpression(expression, environment) {
  expression = expression.trim().replace(/std::string\(\s*("(?:\\.|[^"\\])*"|\w+)\s*\)/g, '$1');
  const tokens = expression.match(/"(?:\\.|[^"\\])*"|\w+|\S/g) ?? [];
  let value = '', expectValue = true;
  for (const token of tokens) {
    if (!expectValue) { if (token !== '+') return undefined; expectValue = true; continue; }
    if (token.startsWith('"')) value += JSON.parse(token);
    else if (Object.hasOwn(environment, token)) value += environment[token];
    else return undefined;
    expectValue = false;
  }
  return expectValue ? undefined : value;
}

function hostServiceRegistrations(source, add, relative) {
  const anchor = /\bStatus\s+HostServices::install\s*\([^)]*\)\s*\{/g;
  const installs = [...source.matchAll(anchor)];
  if (!installs.length) return;
  if (installs.length !== 1) throw new Error(`Ambiguous C++ host service installation in ${relative}`);
  const first = installs[0].index + installs[0][0].length - 1;
  const body = source.slice(first + 1, closing(source, first, '{', '}'));
  const sets = new Map();
  for (const match of source.matchAll(/\bconst\s+std::set<std::string>\s+(\w+)\s*=\s*\{/g)) {
    const start = match.index + match[0].length - 1;
    if (sets.has(match[1])) throw new Error(`Duplicate C++ host API set in ${relative}`);
    sets.set(match[1], argumentsOf(source.slice(start + 1, closing(source, start, '{', '}'))));
  }
  // Follow the installed set, rather than treating every API-looking string
  // or unused declaration as an implementation. Conditions represent the
  // configurable potential surface, not an assertion that consent/payments
  // are installed by default.
  const sinks = [...body.matchAll(/for\s*\(const\s+auto\s*&\s*(\w+)\s*:\s*(\w+)\s*\)\s*\{\s*auto\s+\w+\s*=\s*session->register_api_handler\(\s*\1\s*\)\s*;/g)];
  if (sinks.length !== 1) throw new Error(`Unsupported C++ host API installation in ${relative}`);
  const target = sinks[0][2], roots = [...body.matchAll(/\bauto\s+(\w+)\s*=\s*(\w+)\s*;/g)].filter(match => match[1] === target);
  if (roots.length !== 1 || !sets.has(roots[0][2])) throw new Error(`Unresolved C++ installed host API set in ${relative}`);
  const reached = new Set([roots[0][2]]);
  for (const match of body.matchAll(/\b(\w+)\.insert\s*\(\s*(\w+)\.begin\(\)\s*,\s*\2\.end\(\)\s*\)/g)) {
    if (match[1] !== target) continue;
    if (!sets.has(match[2])) throw new Error(`Unresolved C++ inserted host API set in ${relative}`);
    reached.add(match[2]);
  }
  const insertCalls = [...body.matchAll(new RegExp(`\\b${target}\\.insert\\s*\\(`, 'g'))].length;
  if (insertCalls !== reached.size - 1) throw new Error(`Unsupported C++ host API insertion in ${relative}`);
  if ([...body.matchAll(/\bregister_api_handler\s*\(/g)].length !== 1) throw new Error(`Unsupported C++ host API registration in ${relative}`);
  for (const name of reached) for (const expression of sets.get(name)) {
    if (literalExpression(expression, {}) === undefined) throw new Error(`Nonliteral C++ host API set in ${relative}`);
    add(expression, {});
  }
}

export function cppInventory(input, known, relative = '<C++ source>') {
  const source = uncomment(input), result = new Set();
  function add(expression, environment) {
    const value = literalExpression(expression, environment);
    if (value === '') return; // Subscription cancellation need not invent an off method.
    if (value === undefined) {
      if (/(?:wx\.|object:|component:|weappContainer\.)/.test(expression))
        throw new Error(`Unsupported C++ API registration ${expression.trim()} in ${relative}`);
      return; // Helper definition, rather than a literal adapter registration.
    }
    if (!apiPrefix.test(value) || !known.has(value)) throw new Error(`Unknown C++ registered API ${value} in ${relative}`);
    result.add(value);
  }
  function scan(text, environment = {}) {
    const loops = [];
    for (const match of text.matchAll(/for\s*\(auto\s+(\w+)\s*:\s*\{([^}]+)\}\s*\)/g)) {
      const start = match.index, bodyStart = start + match[0].length, end = statementEnd(text, bodyStart);
      if (loops.some(loop => start >= loop.start && start < loop.end)) continue;
      const values = argumentsOf(match[2]).map(value => literalExpression(value, environment));
      if (values.some(value => value === undefined)) continue;
      loops.push({ start, end });
      for (const value of values) scan(text.slice(bodyStart, end), { ...environment, [match[1]]: value });
    }
    // The common Bluetooth owner forwards the backend vectors inventoried
    // from its platform factory. Accept only this exact forwarding grammar.
    for(const match of text.matchAll(/for\s*\(const\s+auto\s*&\s*(\w+)\s*:\s*bluetooth_platform_\.(apis|events)\s*\)/g)) {
      const start=match.index,bodyStart=start+match[0].length,end=statementEnd(text,bodyStart),body=text.slice(bodyStart,end).replace(/\s+/g,'');
      const variable=match[1],expected=match[2]==='apis'?`add(${variable});`:`add_event("wx.on"+${variable},"wx.off"+${variable},${variable});`;
      if(body!==expected)throw new Error(`Unsupported C++ backend vector forwarding in ${relative}`);
      loops.push({start,end});
    }
    const excluded = [];
    // Constructor registration loops use this guard to exclude RequestTask
    // from progress events. Respect the guard before checking catalog names.
    for (const match of text.matchAll(/if\s*\(\s*(?:std::string\(\s*)?(\w+)\s*\)?\s*(!=|==)\s*("(?:\\.|[^"\\])*")\s*\)/g)) {
      if (!Object.hasOwn(environment, match[1])) continue;
      const equal = environment[match[1]] === JSON.parse(match[3]);
      if (match[2] === '==' ? !equal : equal) {
        const start = match.index + match[0].length;
        excluded.push({ start, end: statementEnd(text, start) });
      }
    }
    const skipped = index => [...loops, ...excluded].some(range => index >= range.start && index < range.end);
    for (const match of text.matchAll(/\b(add|add_event|snapshot)\s*\(/g)) {
      if (skipped(match.index)) continue;
      const start = match.index + match[0].length - 1, end = closing(text, start, '(', ')');
      const args = argumentsOf(text.slice(start + 1, end));
      for (const argument of args.slice(0, match[1] === 'add_event' ? 2 : 1)) add(argument, environment);
    }
    // Backend factories return exact API/event vectors to the common owner.
    // Inventory only the structured literal grammar, including guarded pushes;
    // generic declarations and arbitrary dynamic expressions remain rejected.
    for (const match of text.matchAll(/\b(?:platform|result)\.(apis|events)\s*=\s*\{/g)) {
      if(skipped(match.index))continue;
      const start=match.index+match[0].length-1,end=closing(text,start,'{','}');
      for(const expression of argumentsOf(text.slice(start+1,end))) {
        if(match[1]==='apis')add(expression,environment);
        else {const event=literalExpression(expression,environment);if(event===undefined)throw new Error(`Unsupported C++ event inventory in ${relative}`);add(JSON.stringify('wx.on'+event),environment);add(JSON.stringify('wx.off'+event),environment);}
      }
    }
    for (const match of text.matchAll(/\b(?:platform|result)\.(apis|events)\.push_back\s*\(/g)) {
      if(skipped(match.index))continue;
      const start=match.index+match[0].length-1,end=closing(text,start,'(',')'),expression=text.slice(start+1,end);
      if(match[1]==='apis')add(expression,environment);
      else {const event=literalExpression(expression,environment);if(event===undefined)throw new Error(`Unsupported C++ event inventory in ${relative}`);add(JSON.stringify('wx.on'+event),environment);add(JSON.stringify('wx.off'+event),environment);}
    }
    for (const match of text.matchAll(/\bapis_\s*\[/g)) {
      if (skipped(match.index)) continue;
      const start = match.index + match[0].length - 1, end = closing(text, start, '[', ']');
      if (/^\s*=/.test(text.slice(end + 1))) add(text.slice(start + 1, end), environment);
    }
  }
  scan(source);
  hostServiceRegistrations(source, add, relative);
  return [...result];
}
