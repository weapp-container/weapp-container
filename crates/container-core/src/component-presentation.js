// Native presentation metadata has a separate prepare/commit boundary. It
// neither reconciles instances nor calls application-writable facade helpers.
const __container_component_presentation = (function() {
  const selectionTable = __container_component_selection_pages;
  const eventTable = __container_component_event_pages;
  const extensible = Object.isExtensible;
  let next = 0n;
  let pending = null;
  function fail() { throw "component presentation metadata unavailable"; }
  function value(object, key) { return __receiver_value(object, key); }
  function copy(source, depth) {
    if (source === null || typeof source !== "object") return source;
    if (depth > 64) fail();
    const array = __host_is_array(source);
    const target = array ? [] : __host_create(null);
    const keys = __host_keys(source);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      if (array && key === "length") continue;
      __host_define(target, key, {__proto__:null,value:copy(value(source,key),depth+1),writable:true,enumerable:true,configurable:true});
    }
    return target;
  }
  function write(target, key, replacement) {
    const previous = __host_get_own(target,key);
    if (previous && !__host_get_own(previous,"value") || previous && !previous.configurable && !previous.writable
        || !previous && !extensible(target)) fail();
    const descriptor = {__proto__:null,value:replacement,
      writable:previous ? previous.writable : true,
      enumerable:previous ? previous.enumerable : true,
      configurable:previous ? previous.configurable : true};
    return {__proto__:null,target:target,key:key,descriptor:descriptor};
  }
  function aliases() {
    if (value(__receiver_global,"__container_component_selection_pages") !== selectionTable
        || value(__receiver_global,"__container_component_event_pages") !== eventTable
        || value(__receiver_global,"__container_component_scopes") !== __receiver_scope_table
        || !__host_page_table_current()) fail();
  }
  return function(request) {
    const phase = value(request,"phase");
    if (phase === "commit") {
      const stage = pending;
      if (!stage || value(request,"ticket") !== stage.ticket) fail();
      aliases();
      const page = value(__receiver_pages,stage.pageId);
      if (!page || page.retired || page.token !== stage.pageToken) fail();
      for (let index = 0; index < stage.receivers.length; index++) {
        const held = stage.receivers[index];
        const entry = value(__receiver_scopes,held.scope);
        if (!entry || entry.retired || entry.token !== held.token) fail();
      }
      // Every target is an original ordinary object and every own property was
      // checked before frame acceptance. Defining own data invokes no setter.
      for (let index = 0; index < stage.writes.length; index++) {
        const item = stage.writes[index];
        __host_define(item.target,item.key,item.descriptor);
      }
      pending = null;
      return "true";
    }
    if (phase !== "stage") fail();
    aliases();
    pending = null;
    const pageId = value(request,"pageId");
    const page = value(__receiver_pages,pageId);
    if (!page || page.retired || __host_page_receiver(pageId) !== page.receiver) fail();
    const scopes = value(request,"scopes");
    const selections = copy(value(request,"selectionNodes"),0);
    const events = copy(value(request,"eventNodes"),0);
    if (!__host_is_array(scopes) || !__host_is_array(selections) || !__host_is_array(events)
        || scopes.length > 100000 || selections.length > 100000 || events.length > 100000) fail();
    const receivers = [];
    const byScope = __host_create(null);
    const writes = [];
    function append(array,item) { __host_define(array,__host_string(array.length),{__proto__:null,value:item,writable:true,enumerable:true,configurable:true}); }
    for (let index = 0; index < scopes.length; index++) {
      const scope = value(scopes,__host_string(index));
      const entry = value(__receiver_scopes,scope);
      if (!entry || entry.retired || entry.pageId !== pageId || entry.pageToken !== page.token
          || value(__receiver_scope_table,scope) !== entry.receiver || value(byScope,scope)) fail();
      __host_define(byScope,scope,{__proto__:null,value:entry});
      append(receivers,{__proto__:null,scope:scope,token:entry.token});
    }
    const graph = {__proto__:null,pageId:pageId,nodes:__host_create(null),hosts:__host_create(null)};
    for (let index = 0; index < events.length; index++) {
      const node = events[index];
      if (typeof node.key !== "string" || value(graph.nodes,node.key)
          || node.ownerScopeId !== null && !value(byScope,node.ownerScopeId)) fail();
      __host_define(graph.nodes,node.key,{__proto__:null,value:node,enumerable:true});
      if (node.componentScopeId !== null) {
        if (!value(byScope,node.componentScopeId) || value(graph.hosts,node.componentScopeId)) fail();
        __host_define(graph.hosts,node.componentScopeId,{__proto__:null,value:node.key,enumerable:true});
      }
    }
    const selected = __host_create(null);
    for (let index = 0; index < selections.length; index++) {
      const node = selections[index];
      if (node.ownerScopeId !== null && !value(byScope,node.ownerScopeId)) fail();
      if (node.componentScopeId === null) continue;
      const entry = value(byScope,node.componentScopeId);
      if (!entry || value(selected,node.componentScopeId)) fail();
      __host_define(selected,node.componentScopeId,{__proto__:null,value:true});
      append(writes,write(entry.receiver,"__container_selection",node.selection));
      if (value(entry.receiver,"id") !== node.selection.id) append(writes,write(entry.receiver,"id",node.selection.id));
    }
    for (let index = 0; index < scopes.length; index++) {
      const scope = value(scopes,__host_string(index));
      if (!value(graph.hosts,scope) || !value(selected,scope)) fail();
    }
    append(writes,write(selectionTable,pageId,selections));
    append(writes,write(eventTable,pageId,graph));
    if (next >= 18446744073709551615n) fail();
    const ticket = __host_string(++next);
    pending = {__proto__:null,ticket:ticket,pageId:pageId,pageToken:page.token,receivers:receivers,writes:writes};
    return __receiver_snapshot_json({__proto__:null,ticket:ticket});
  };
})();
