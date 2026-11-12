//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region weapp-container-source:state.ts
let counter = 0;
function bump() {
	return ++counter;
}
//#endregion
//#region weapp-container-source:shared.view.js
var weapp_container_source_shared_view_exports = /* @__PURE__ */ __exportAll({
	bump: () => bump,
	counter: () => counter
});
//#endregion
//#region weapp-container-source:safe-b.ts
function readNameA() {
	return "a";
}
function cycle() {
	return `a:b:${readNameA()}`;
}
//#endregion
//#region weapp-container-source:main.view.ts
var weapp_container_source_main_view_exports = /* @__PURE__ */ __exportAll({
	exercise: () => exercise,
	readImported: () => readImported
});
var Unit = /* @__PURE__ */ function(Unit) {
	Unit["Point"] = "points";
	return Unit;
}(Unit || {});
var Box = class {
	#value = 0;
	constructor(values) {
		for (const value of values) this.#value += value;
	}
	get value() {
		return this.#value;
	}
};
function* unique(values) {
	yield* new Set(values);
}
function exercise() {
	const before = counter;
	bump();
	const box = new Box(unique([
		1,
		2,
		2,
		3
	]));
	return `before=${before};after=${counter};sum=${box.value};unit=points;cycle=${cycle()}`;
}
function readImported() {
	return counter;
}
//#endregion
//#region weapp-container-modern-view:68c9cd2a2380293024e5a048ac40a1d014b4a048764d6bb2b1c25cfa4db3cd31
var weapp_container_modern_view_68c9cd2a2380293024e5a048ac40a1d014b4a048764d6bb2b1c25cfa4db3cd31_default = { ["page.wxml"]: {
	["shared"]: weapp_container_source_shared_view_exports,
	["tools"]: weapp_container_source_main_view_exports
} };
//#endregion
module.exports = weapp_container_modern_view_68c9cd2a2380293024e5a048ac40a1d014b4a048764d6bb2b1c25cfa4db3cd31_default;
