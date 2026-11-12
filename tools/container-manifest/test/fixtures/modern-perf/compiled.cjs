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
//#region weapp-container-source:compute.view.ts
var weapp_container_source_compute_view_exports = /* @__PURE__ */ __exportAll({ compute: () => compute });
function compute({ items, factor }) {
	let total = 0;
	for (let index = 0; index < items.length; index++) total += items[index].value * factor;
	return {
		total,
		label: `sum:${total}`,
		count: items.length
	};
}
//#endregion
//#region weapp-container-modern-view:963259af55fa73743d00727ba8db82485d85f6bc21fe1aba7f8c83ac8e7cc314
var weapp_container_modern_view_963259af55fa73743d00727ba8db82485d85f6bc21fe1aba7f8c83ac8e7cc314_default = { ["page.wxml"]: { ["tools"]: weapp_container_source_compute_view_exports } };
//#endregion
module.exports = weapp_container_modern_view_963259af55fa73743d00727ba8db82485d85f6bc21fe1aba7f8c83ac8e7cc314_default;
