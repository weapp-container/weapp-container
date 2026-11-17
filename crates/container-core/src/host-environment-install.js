// This source runs inside the facade's bootstrap scope, before applications.
// Native engines retain the returned function; it is never an app global.
function __host_descriptor(value) {
  const descriptor = __host_create(null);
  descriptor.value = value;
  descriptor.writable = descriptor.enumerable = descriptor.configurable = true;
  return descriptor;
}
function __host_map(source) {
  if (source === null || typeof source !== "object" || __host_is_array(source)) return null;
  const result = __host_create(null);
  const keys = __host_keys(source);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    __host_define(result, key, __host_descriptor(source[key]));
  }
  return result;
}
function __host_contract(enabled) {
  const contract = __host_create(null);
  __host_define(contract, "version", __host_descriptor("1.0"));
  __host_define(contract, "enabled", __host_descriptor(enabled));
  return contract;
}
// These aliases preserve diagnostic reads and existing mutations of the map
// contents. Replacing/freezing an alias cannot replace the private live cell.
function __host_alias(name, read) {
  const descriptor = __host_create(null);
  descriptor.get = read;
  descriptor.enumerable = descriptor.configurable = true;
  __host_define(globalThis, name, descriptor);
}
__host_alias("__container_storage", function() { return __container_storage; });
__host_alias("__container_sync_api_values", function() { return __container_sync_api_values; });
__host_alias("__container_sync_api_errors", function() { return __container_sync_api_errors; });
__host_alias("__container_sync_files", function() { return __container_sync_files; });
__host_alias("__container_sync_files_available", function() { return __container_sync_files_available; });
__host_alias("__container_capabilities", function() { return __container_capabilities; });

function __host_value(object, key) {
  const descriptor = __host_get_own(object, key);
  return descriptor ? descriptor.value : undefined;
}
return function(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || __host_is_array(snapshot)) return false;
  // Compatibility entry points use this same retained function, never eval or
  // an application-replaceable setter. Full runtime installation uses version.
  const kind = __host_value(snapshot, "kind");
  if (kind === "module-command") return __container_module_owner.command(snapshot);
  if (kind === "performance-retire") { __container_performance.retire(); return true; }
  if (kind === "pages-prepare") return __host_prepare_pages(snapshot);
  if (kind === "pages-commit") return __host_commit_pages(__host_value(snapshot, "token"));
  if (kind === "pages-cancel") { delete __host_page_prepared[__host_value(snapshot, "token")]; return true; }
  if (kind === "finite-notification") {
    __container_finite_notifications.receive(__host_value(snapshot, "api"), __host_value(snapshot, "event"));
    return true;
  }
  if (kind === "finite-notification-cancel-ack") return __container_finite_notifications.acknowledge(__host_value(snapshot, "subscriptionId"));
  if (kind === "finite-notification-object-retire") {
    if (!__container_finite_notifications.validObjectId(__host_value(snapshot, "objectId"))) return false;
    // Native completion can repeat a retirement performed in the calling turn.
    // A valid command acknowledges absence; the owner's removal result remains
    // separate, and exceptions still propagate through the retained transport.
    __container_finite_notifications.retireObject(__host_value(snapshot, "objectId"));
    return true;
  }
  if (kind === "storage-ack") return __host_storage_ack(__host_value(snapshot, "sequence"));
  if (kind === "storage-restore") {
    const prepared = __host_storage_prepare_snapshot(__host_value(snapshot, "storage"));
    if (!prepared) return false;
    __storage_publish(prepared);
    return true;
  }
  if (kind === "effects-ack") {
    // The token selects a private captured batch, never a user-supplied count.
    // Only its original tail may retire; patches created by serialization
    // remain linked after that tail for the following host batch.
    const pending = __host_drain_pending;
    if (!pending || __host_value(snapshot, "drainId") !== pending.id) return false;
    if (pending.tail && __host_value(snapshot, "keepStorage") !== true
        && !__host_storage_ack(pending.tail.sequence)) return false;
    if (pending.componentTail) {
      __receiver_component_head = pending.componentTail.next;
      if (!__receiver_component_head) __receiver_component_tail = null;
    }
    __receiver_write_ack(pending.writeTail);
    __host_drain_pending = null;
    return true;
  }
  if (kind === "capabilities") {
    const capabilities = __host_map(__host_value(snapshot, "capabilities"));
    if (!capabilities) return false;
    __container_routes.install(capabilities);
    __container_error_notifications.install(capabilities);
    __container_page_not_found.install(capabilities);
    __container_unhandled_rejections.install(capabilities);
    __container_window_resize.install(capabilities);
    __container_host_layout.install(capabilities);
    __container_finite_notifications.install(capabilities);
    __container_lifecycle_notifications.install(capabilities);
    __container_log_manager.install(capabilities);
    __container_performance.install(capabilities);
    __container_turn_scheduler.install(capabilities);
    __container_buffer_urls.install(capabilities);
    __container_capabilities = capabilities;
    return true;
  }
  if (kind === "dom-query") {
    if (typeof __host_value(snapshot, "enabled") !== "boolean") return false;
    __host_dom(__host_contract(__host_value(snapshot, "enabled")));
    return true;
  }
  if (__host_value(snapshot, "version") !== "1.0" || typeof __host_value(snapshot, "domQuery") !== "boolean") return false;
  const capabilities = __host_map(__host_value(snapshot, "capabilities"));
  const values = __host_map(__host_value(snapshot, "syncApiValues"));
  const errors = __host_map(__host_value(snapshot, "syncApiErrors"));
  if (!capabilities || !values || !errors) return false;
  // Preserve means use these private live references. It must never read the
  // mutable global aliases, whose getters may now belong to the application.
  let storage = __container_storage;
  let storageState = null;
  if (__host_value(snapshot, "storage") !== null) {
    storageState = __host_storage_prepare_snapshot(__host_value(snapshot, "storage"));
    if (!storageState) return false;
    storage = storageState.projection;
  }
  const files = __host_value(snapshot, "files") === null ? __container_sync_files : __host_map(__host_value(snapshot, "files"));
  if (!files) return false;
  // The captured DOM owner setter uses captured intrinsics too. After this
  // prevalidated policy installation, publication consists only of cell moves.
  __host_dom(__host_contract(__host_value(snapshot, "domQuery")));
  __container_routes.install(capabilities);
  __container_error_notifications.install(capabilities);
  __container_page_not_found.install(capabilities);
  __container_unhandled_rejections.install(capabilities);
  __container_window_resize.install(capabilities);
    __container_host_layout.install(capabilities);
  __container_finite_notifications.install(capabilities);
  __container_lifecycle_notifications.install(capabilities);
  __container_log_manager.install(capabilities);
  __container_performance.install(capabilities);
  __container_turn_scheduler.install(capabilities);
  __container_buffer_urls.install(capabilities);
  __container_capabilities = capabilities;
  __container_sync_api_values = values;
  __container_sync_api_errors = errors;
  if (storageState) __storage_publish(storageState);
  else __container_storage = storage;
  __container_sync_files = files;
  if (__host_value(snapshot, "files") !== null) __container_sync_files_available = true;
  return true;
};
