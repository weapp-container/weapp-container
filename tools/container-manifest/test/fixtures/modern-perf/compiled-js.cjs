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
//#region weapp-container-source:compute.view.js
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
//#region weapp-container-modern-view:e9d22f887081226e68a936a7916b47bd8222a0e045fb72cbaad7f290d3d7a72b
var weapp_container_modern_view_e9d22f887081226e68a936a7916b47bd8222a0e045fb72cbaad7f290d3d7a72b_default = { ["page.wxml"]: { ["tools"]: weapp_container_source_compute_view_exports } };
//#endregion
module.exports = weapp_container_modern_view_e9d22f887081226e68a936a7916b47bd8222a0e045fb72cbaad7f290d3d7a72b_default;
