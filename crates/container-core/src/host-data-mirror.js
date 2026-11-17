// Private AppService transport. Values are already independent JSON snapshots
// from the native batch parser, so ownership can move directly into Page.data.
// Keep this separate from user setData: host patches must not invoke observers,
// callbacks, or enqueue a second data.patch.batch effect.
(function() {
  const resolvePage = globalThis.__container_native_page_lookup;
  const create = Object.create;
  const getPrototypeOf = Object.getPrototypeOf;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const isExtensible = Object.isExtensible;
  const defineProperty = Object.defineProperty;
  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const isArray = Array.isArray;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;

  function matching(target, array) {
    return array ? isArray(target)
      : target !== null && typeof target === "object" && !isArray(target);
  }

  function containerFor(target, array, containers) {
    let container = containers.get(target);
    if (container) return container;
    const prototype = getPrototypeOf(target);
    if (prototype !== null && prototype !== (array ? arrayPrototype : objectPrototype)) {
      throw new TypeError("data.patch.batch:fail custom data prototype is unsupported");
    }
    container = { properties: create(null), extensible: isExtensible(target), length: array ? target.length : 0, lengthWritable: !array || getOwnPropertyDescriptor(target, "length").writable };
    containers.set(target, container);
    return container;
  }

  function descriptorFor(target, part, container) {
    if (hasOwn(container.properties, part)) return container.properties[part];
    const descriptor = getOwnPropertyDescriptor(target, part);
    container.properties[part] = descriptor;
    return descriptor;
  }

  function planStore(plan, target, part, value, descriptor, container) {
    // Existing enumerable writable data properties can use ordinary assignment.
    // New/non-enumerable properties use defineProperty to bypass inherited
    // setters and retain the public mirror's enumerable JSON-data semantics.
    plan.push(target, part, value, descriptor && descriptor.enumerable ? 0 : 1);
    if (descriptor) {
      descriptor.value = value;
      descriptor.enumerable = descriptor.writable = descriptor.configurable = true;
      container.properties[part] = descriptor;
    } else container.properties[part] = { value: value, enumerable: true, writable: true, configurable: true };
    if (typeof part === "number" && part >= container.length) container.length = part + 1;
  }

  function preflight(root, parts, value, deleting, containers, plan) {
    if (!parts.length) return deleting ? null : value;
    const rootArray = typeof parts[0] === "number";
    if (!matching(root, rootArray)) {
      if (deleting) return root;
      root = rootArray ? [] : {};
    }
    let target = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const array = typeof part === "number";
      const container = containerFor(target, array, containers);
      const descriptor = descriptorFor(target, part, container);
      if (!descriptor) {
        if (deleting) return root;
        if (!container.extensible) throw new TypeError("data.patch.batch:fail data is not extensible");
      } else if (!hasOwn(descriptor, "value") || !descriptor.configurable || (!deleting && !descriptor.writable)) {
        throw new TypeError("data.patch.batch:fail data path must be writable and configurable");
      }
      if (array && !deleting && part >= container.length && !container.lengthWritable) {
        throw new TypeError("data.patch.batch:fail array length is not writable");
      }
      if (index + 1 === parts.length) {
        if (deleting && !array) {
          plan.push(target, part, null, 2);
          container.properties[part] = undefined;
        } else {
          // Array deletion is a JSON null, preserving indices and length.
          planStore(plan, target, part, deleting ? null : value, deleting ? null : descriptor, container);
        }
        return root;
      }
      let child = descriptor ? descriptor.value : null;
      const childArray = typeof parts[index + 1] === "number";
      if (!matching(child, childArray)) {
        if (deleting) return root;
        child = childArray ? [] : {};
        planStore(plan, target, part, child, descriptor, container);
      } else if (!descriptor.enumerable) {
        planStore(plan, target, part, child, descriptor, container);
      }
      target = child;
    }
    return root;
  }

  globalThis.__container_apply_page_data_batch = function(instanceId, patches) {
    const page = resolvePage(String(instanceId));
    if (!page) return false;
    const descriptor = getOwnPropertyDescriptor(page, "data");
    if (!descriptor || !hasOwn(descriptor, "value") || !descriptor.writable) {
      throw new TypeError("data.patch.batch:fail Page.data must be a writable data property");
    }
    // The shadow descriptor graph sees earlier operations in this batch,
    // including aliases and delete-then-set on non-extensible objects. No live
    // destination changes until every operation has passed validation.
    const containers = new WeakMap();
    const plan = [];
    let data = page.data;
    for (let index = 0; index < patches.length; index += 1) {
      const patch = patches[index];
      data = preflight(data, patch[0], patch[2], patch[1], containers, plan);
    }
    for (let index = 0; index < plan.length; index += 4) {
      const target = plan[index];
      const part = plan[index + 1];
      const value = plan[index + 2];
      if (plan[index + 3] === 0) target[part] = value;
      else if (plan[index + 3] === 1) defineProperty(target, part, { value: value, enumerable: true, writable: true, configurable: true });
      else delete target[part];
    }
    page.data = data;
    return true;
  };
})();
