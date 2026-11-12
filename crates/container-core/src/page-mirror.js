// A prepared page mirror is private to the bootstrap. Preparation can fail;
// publication does not inspect an application object or invoke its helpers.
const __host_page_definitions = globalThis.__container_pages;
// Once the host opts in through a trusted mirror commit, application-writable
// compatibility tables no longer participate in publication or lookup.
const __host_page_instances = __host_create(null);
let __host_atomic_page_mode = false;
function __host_page_table_current() {
  return __host_atomic_page_mode || __receiver_value(__receiver_global, "__container_page_instances") === __receiver_page_table;
}
function __host_page_receiver(id) {
  return __receiver_value(__host_atomic_page_mode ? __host_page_instances : __receiver_page_table, id);
}
function __host_page_lookup(id) {
  return __host_atomic_page_mode ? __receiver_value(__host_page_instances, id) : globalThis.__container_page_instances[id];
}
const __host_page_slice = Function.prototype.call.bind(Array.prototype.slice);
const __host_page_json_primitive = JSON.stringify;
const __host_page_object_prototype = Object.prototype;
const __host_page_array_prototype = Array.prototype;
function __host_page_json(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return __host_page_json_primitive(value);
  let output = __host_is_array(value) ? "[" : "{";
  let count = 0;
  if (__host_is_array(value)) {
    for (let i = 0; i < value.length; i++) { if (i) output += ","; const item=__host_page_json(__page_value(value,__host_string(i))); output += item === undefined ? "null" : item; }
    return output + "]";
  }
  const keys=__host_keys(value);
  for (let i=0;i<keys.length;i++) {
    const key=keys[i]; if(typeof key !== "string") continue;
    const descriptor=__host_get_own(value,key); if(!descriptor || !descriptor.enumerable) continue;
    const item=__host_page_json(descriptor.value); if(item===undefined) continue;
    if(count++) output+=","; output+=__host_page_json_primitive(key)+":"+item;
  }
  return output+"}";
}
const __host_page_set_proto = Object.setPrototypeOf;
const __host_page_prepared = __host_create(null);
function __page_descriptor(value) { const record = __host_create(null); record.value=value; record.writable=record.enumerable=record.configurable=true; return record; }
function __page_value(object, key) { if (!object || typeof object !== "object") return undefined; const descriptor=__host_get_own(object,key); return descriptor ? descriptor.value : undefined; }
let __host_current_pages = null;
function __host_copy_page_array(pages) { return __host_page_slice(pages); }
function __host_plain_clone(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") throw "invalid page data";
  for (let i = 0; i < seen.length; i++) if (seen[i] === value) throw "cyclic page data";
  const path = __host_page_slice(seen); __host_define(path, __host_string(path.length), __page_descriptor(value));
  const array = __host_is_array(value);
  const result = array ? __host_page_set_proto([], __host_page_array_prototype) : __host_create(__host_page_object_prototype);
  const keys = __host_keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (array && key === "length") continue;
    if (typeof key !== "string") continue;
    const descriptor = __host_get_own(value, key);
    if (!descriptor || !descriptor.enumerable) continue;
    if (!__host_get_own(descriptor, "value")) throw "page data accessor is unsupported";
    __host_define(result, key, __page_descriptor(__host_plain_clone(descriptor.value, path)));
  }
  return result;
}
function __host_prepare_pages(snapshot) {
  const token = __page_value(snapshot, "token");
  const records = __page_value(snapshot, "records");
  if (typeof token !== "string" || !token || !__host_is_array(records)) throw "invalid page mirror preparation";
  const instances = __host_page_set_proto([], null), created = __host_page_set_proto([], null), registrations = __host_page_set_proto([], null), entries = __host_page_set_proto([], null);
  for (let i = 0; i < records.length; i++) {
    const record = __page_value(records, __host_string(i));
    const index = __page_value(record, "index");
    const id = __host_string(__page_value(record, "instanceId"));
    const definition = __page_value(__host_page_definitions, __host_string(index));
    if (!definition || typeof definition !== "object") throw "page definition unavailable";
    // On first opt-in, import an actual registered receiver, never an object
    // substituted into the public diagnostic alias by application code.
    const existing = __page_value(__receiver_pages, id);
    let instance = __host_atomic_page_mode ? __page_value(__host_page_instances, id) : existing && existing.receiver;
    if (!instance) {
      instance = __host_create(definition);
      const data = __host_plain_clone(__page_value(definition, "data") || __host_create(null), []);
      const overrides = __page_value(record, "data");
      if (overrides && typeof overrides === "object") {
        const keys = __host_keys(overrides);
        for (let j = 0; j < keys.length; j++) {
          const key = keys[j];
          __host_define(data, key, __page_descriptor(__host_plain_clone(__page_value(overrides, key), [])));
        }
      }
      __host_define(instance, "data", __page_descriptor(data));
      __host_define(instance, "__container_page_index", __page_descriptor(index));
      __host_define(instance, "__container_instance_id", __page_descriptor(id));
      __host_define(instance, "setData", __page_descriptor(function(patch, callback) { return __container_set_data(this, patch, callback); }));
      __host_define(instance, "route", __page_descriptor(__page_value(record, "route")));
      __host_define(instance, "options", __page_descriptor(__host_plain_clone(__page_value(record, "options") || __host_create(null), [])));
      __host_define(registrations, __host_string(registrations.length), __page_descriptor({id:id, instance:instance}));
      const item = __host_create(null); item.instanceId = __page_value(record, "instanceId"); item.data = data;
      __host_define(created, __host_string(created.length), __page_descriptor(item));
    }
    const entry = __host_create(null); entry.id = id; entry.instance = instance;
    __host_define(entries, __host_string(entries.length), __page_descriptor(entry));
    __host_define(instances, __host_string(i), __page_descriptor(instance));
  }
  // Encode before publishing; captured JSON only sees freshly cloned data.
  const output = __host_create(null); output.created = created;
  const receipt = __host_page_json(output);
  const prepared = __host_create(null); prepared.token=token; prepared.instances=instances; prepared.registrations=registrations; prepared.entries=entries;
  __host_define(__host_page_prepared, token, __page_descriptor(prepared));
  return receipt;
}
function __host_commit_pages(token) {
  const prepared = __page_value(__host_page_prepared, token);
  if (!prepared || prepared.token !== token) return false;
  for (let i = 0; i < prepared.registrations.length; i++) {
    const registration = prepared.registrations[i];
    __receiver_register(registration.instance, registration.id, null);
  }
  for (let i = 0; i < prepared.entries.length; i++) {
    const entry = prepared.entries[i];
    __host_define(__host_page_instances, entry.id, __page_descriptor(entry.instance));
  }
  // Hidden tab receivers remain live. Retired pages no longer own a
  // bootstrap strong reference once their departure hooks have completed.
  const ids = __host_keys(__host_page_instances);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const instance = __page_value(__host_page_instances, id);
    const entry = __receiver_get(__receiver_weak, instance);
    if (entry && entry.retired) delete __host_page_instances[id];
  }
  __host_atomic_page_mode = true;
  __host_current_pages = prepared.instances;
  delete __host_page_prepared[token];
  return true;
}
