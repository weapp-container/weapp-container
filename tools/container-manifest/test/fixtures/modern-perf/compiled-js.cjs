// \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, flags) => {
	let target = Object.setPrototypeOf({}, null);
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!(flags & 1)) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return flags & 2 ? target : Object.preventExtensions(target);
};
// weapp-container-source:compute.view.js
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
// weapp-container-modern-view:e9d22f887081226e68a936a7916b47bd8222a0e045fb72cbaad7f290d3d7a72b
var weapp_container_modern_view_e9d22f887081226e68a936a7916b47bd8222a0e045fb72cbaad7f290d3d7a72b_default = { ["page.wxml"]: { ["tools"]: weapp_container_source_compute_view_exports } };
module.exports = weapp_container_modern_view_e9d22f887081226e68a936a7916b47bd8222a0e045fb72cbaad7f290d3d7a72b_default;
