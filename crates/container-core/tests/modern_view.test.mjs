import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const modern = readFileSync(
  new URL("../src/modern_view.js", import.meta.url),
  "utf8",
);
const legacy = readFileSync(new URL("../src/view.js", import.meta.url), "utf8");
function realm(source = modern, countFactories = false) {
  const context = vm.createContext({});
  vm.runInContext(
    "const __parse=JSON.parse, __serialize=JSON.stringify;",
    context,
  );
  if (countFactories)
    vm.runInContext(
      `
    let __factories=0;
    const __construct=Reflect.construct;
    Function=new Proxy(Function,{construct(target,args){__factories++;return __construct(target,args);}});
  `,
      context,
    );
  vm.runInContext(source, context);
  return {
    call(op, input) {
      context.__input = JSON.stringify(input);
      const result = JSON.parse(
        vm.runInContext(
          `__serialize(__weappContainer_view_${op}(__parse(__input)))`,
          context,
        ),
      );
      return typeof result === "string" ? JSON.parse(result) : result;
    },
    factories() {
      return vm.runInContext("__factories", context);
    },
  };
}
function load(runtime, source) {
  assert.deepEqual(
    runtime.call("load", [{ id: "modern:unit.mjs", source, dependencies: [] }]),
    {
      ok: true,
    },
  );
}
function document(value, attrs) {
  return {
    documentId: "page.wxml",
    bindings: { tools: "modern:unit.mjs" },
    ast: {
      version: 1,
      nodes: [
        attrs
          ? { kind: "element", tag: "view", attrs, bindings: [], children: [] }
          : { kind: "text", value, bindings: [] },
      ],
    },
  };
}
function render(runtime, doc, data = {}) {
  return runtime.call("render", {
    documents: [doc],
    tasks: [
      { taskId: "render", scopeId: "page", documentId: "page.wxml", data },
    ],
  });
}

test("modern namespaces retain class construction, identity and one render snapshot", () => {
  const runtime = realm();
  load(
    runtime,
    `class Box { constructor(x){this.x=x} }
    function change(value){value.n++;return value.n}
    module.exports={'page.wxml':{tools:{Box,arr:[],change}}};`,
  );
  const output = render(
    runtime,
    document(
      "{{new tools.Box(7).x}}/{{tools.arr.constructor===Array}}/{{tools.change(payload)}}/{{payload.n}}",
    ),
    { payload: { n: 1 } },
  );
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.equal(output.results[0].ast.nodes[0].value, "7/true/2/2");
  const again = render(runtime, document("{{payload.n}}"), {
    payload: { n: 1 },
  });
  assert.equal(again.results[0].ast.nodes[0].value, "1");
});

test("mutable standard intrinsics cannot rewrite transport, metadata or later compilation", () => {
  const runtime = realm();
  load(
    runtime,
    readFileSync(
      new URL("./support/modern_attack.js", import.meta.url),
      "utf8",
    ),
  );
  const first = render(
    runtime,
    document("", { payload: "{{tools.attack()}}" }),
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.results[0].ast.nodes[0].boundValues.payload, {
    n: 1,
    rows: [1, 2],
  });
  const second = render(runtime, document("", { payload: "{{tools.read()}}" }));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.results[0].ast.nodes[0].boundValues.payload, {
    n: 2,
    rows: [3, 4],
  });
  assert.equal(render(runtime, document("{{tools.flipDescriptors()}}")).results[0].ast.nodes[0].value, "flipped");
  const userString = render(runtime, document("{{String(0)}}"));
  assert.equal(userString.error.code, "ERR_VIEW_EXECUTION");
  assert.match(userString.error.message, /poisoned transport intrinsic/);
  const bad = runtime.call("render", {
    documents: [],
    tasks: [
      { taskId: "bad", scopeId: "page", documentId: "missing.wxml", data: {} },
    ],
  });
  assert.equal(bad.error.code, "ERR_VIEW_INVALID_BATCH");
  assert.equal(runtime.call("release_scopes", ["page"]).ok, true);
  const third = render(runtime, document("{{tools.read().n}}"));
  assert.equal(third.results[0].ast.nodes[0].value, "1");
});

test("modern sink rejects async, opaque values, bigint and cycles without invoking toJSON", () => {
  for (const expression of [
    "Promise.resolve(1)",
    "new Map()",
    "1n",
    "(()=>{let a={};a.self=a;return a})()",
    "({then(){}})",
  ]) {
    const runtime = realm();
    load(
      runtime,
      `module.exports={'page.wxml':{tools:{value(){return ${expression}}}}};`,
    );
    const output = render(
      runtime,
      document("", { payload: "{{tools.value()}}" }),
    );
    assert.equal(output.error.code, "ERR_VIEW_UNSUPPORTED_VALUE", expression);
  }
});

test("private JSON transport preserves scalar strings and rejects lone surrogate sinks", () => {
  const runtime = realm();
  load(runtime, String.raw`
    const tools={
      payload(){return Object.setPrototypeOf(['"\\\n\r\t\b\f\u0000\u001f/中文\u2028\u2029\ud83d\ude80',null,true,1],null)},
      lone(){return '\ud800'},
      badKey(){return {['\udfff']:1}},
      internal(){return '\ud800'.length},
      fail(){throw new Error('broken:\ud800')},
      hostile(){throw {get message(){throw 1},get stack(){throw 2},toString(){throw 3}}}
    };
    module.exports={'page.wxml':{tools}};
  `);
  const expected = '"\\\n\r\t\b\f\u0000\u001f/中文\u2028\u2029🚀';
  const result = render(runtime, document("", { payload: "{{tools.payload()}}" }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.results[0].ast.nodes[0].boundValues.payload, [expected, null, true, 1]);
  assert.equal(render(runtime, document("{{tools.payload()[0]}}")).results[0].ast.nodes[0].value, expected);
  for (const expression of ["tools.lone()", "tools.badKey()"])
    assert.equal(render(runtime, document("", {payload:`{{${expression}}}`})).error.code, "ERR_VIEW_UNSUPPORTED_VALUE");
  assert.equal(render(runtime, document("{{tools.lone()}}")).error.code, "ERR_VIEW_UNSUPPORTED_VALUE");
  assert.equal(render(runtime, document("{{tools.internal()}}")).results[0].ast.nodes[0].value, "1");
  assert.match(render(runtime, document("{{tools.fail()}}")).error.message, /broken:\\ud800/);
  assert.equal(render(runtime, document("{{tools.hostile()}}")).error.code, "ERR_VIEW_EXECUTION");
});

test("modern expression programs persist, remain bounded, and reset on registry replacement", () => {
  const runtime = realm(modern, true);
  load(
    runtime,
    "module.exports={'page.wxml':{tools:{n:0,next(){return ++this.n}}}};",
  );
  const doc = document("{{tools.next()}}");
  assert.equal(render(runtime, doc).results[0].ast.nodes[0].value, "1");
  const count = runtime.factories();
  assert.equal(render(runtime, doc).results[0].ast.nodes[0].value, "2");
  assert.equal(runtime.factories(), count);
  for (let index = 0; index < 4100; index++) {
    assert.equal(render(runtime, document(`{{${index}}}`)).ok, true);
  }
  const beforeEvicted = runtime.factories();
  assert.equal(render(runtime, doc).results[0].ast.nodes[0].value, "3");
  assert.equal(runtime.factories(), beforeEvicted + 1);
  load(
    runtime,
    "module.exports={'page.wxml':{tools:{n:0,next(){return ++this.n}}}};",
  );
  const reloaded = runtime.factories();
  assert.equal(render(runtime, doc).results[0].ast.nodes[0].value, "1");
  assert.equal(runtime.factories(), reloaded + 1);
});

test("legacy cache reuses functions without memoizing stateful WXS results", () => {
  const runtime = realm(legacy, true);
  const source = "let n=0;exports.next=function(){return ++n}";
  assert.equal(
    runtime.call("load", [{ id: "wxs:tools.wxs", source, dependencies: [] }])
      .ok,
    true,
  );
  const doc = document("{{tools.next()}}");
  doc.bindings.tools = "wxs:tools.wxs";
  assert.equal(render(runtime, doc).results[0].ast.nodes[0].value, "1");
  const count = runtime.factories();
  assert.equal(render(runtime, doc).results[0].ast.nodes[0].value, "2");
  assert.equal(runtime.factories(), count);
  assert.equal(
    runtime.call("load", [{ id: "wxs:tools.wxs", source, dependencies: [] }])
      .ok,
    true,
  );
  const before = runtime.factories();
  assert.equal(render(runtime, doc).results[0].ast.nodes[0].value, "1");
  assert.equal(runtime.factories(), before + 1);
});
