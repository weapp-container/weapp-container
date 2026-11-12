import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cppInventory } from './cpp-api-inventory.mjs';

const catalog = JSON.parse(await readFile(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)));
const known = new Set(catalog.apis.map(api => api.name));

test('C++ inventory rejects invented task methods in every registration form', () => {
  for (const source of [
    'add_event("object:SocketTask.onOpen", "object:SocketTask.offOpen", "Open");',
    'for (auto event : {"Open", "Close"}) add_event(std::string("object:SocketTask.on")+event, std::string("object:SocketTask.off")+event, event);',
    'for(auto event:{"Start","Stop"}) apis_["object:RecorderManager.off"+std::string(event)]=event;',
  ]) assert.throws(() => cppInventory(source, known), /Unknown C\+\+ registered API/);
});

test('C++ inventory preserves all real loop branches and guarded task progress events', () => {
  const names = cppInventory(`
    for(auto type:{"RequestTask","DownloadTask","UploadTask"}) {
      add_event("object:"+std::string(type)+".onHeadersReceived","object:"+std::string(type)+".offHeadersReceived","HeadersReceived");
      if(std::string(type)!="RequestTask")add_event("object:"+std::string(type)+".onProgressUpdate","object:"+std::string(type)+".offProgressUpdate","ProgressUpdate");
    }
    for(auto event:{"Open","Close"})apis_["object:SocketTask.on"+std::string(event)]=event;
    snapshot("wx.getBatteryInfoSync", {{"level",100}});
  `, known);
  assert.equal(names.length, 13);
  assert(names.includes('object:DownloadTask.onProgressUpdate'));
  assert(names.includes('object:UploadTask.offProgressUpdate'));
  assert(names.includes('object:SocketTask.onClose'));
  assert(names.includes('wx.getBatteryInfoSync'));
});

test('C++ inventory fails closed for unsupported literal registration expressions', () => {
  assert.throws(() => cppInventory('add("wx." + select_api());', known), /Unsupported C\+\+ API registration/);
  assert.deepEqual(cppInventory('// add("wx.fake");\nvoid add(const std::string& api){apis_[api]=true;}', known), []);
});

test('backend API and event vectors preserve guarded implementation branches and reject unknown leaves',()=>{
  const values=cppInventory(`
    platform.apis={"wx.openBluetoothAdapter"};
    platform.events={"BluetoothDeviceFound"};
    if(options.exclusive){for(auto api:{"wx.createBLEConnection","wx.closeBLEConnection"})platform.apis.push_back(api);platform.events.push_back("BLEConnectionStateChange");}
    result.apis={"wx.getBLEMTU"};result.events={"BLEMTUChange"};
  `,known)
  assert.equal(values.length,10);assert(values.includes('wx.createBLEConnection'));assert(values.includes('wx.offBLEMTUChange'))
  assert.throws(()=>cppInventory('platform.apis={"wx.fakeBluetooth"};',known),/Unknown C\+\+ registered API/)
  assert.throws(()=>cppInventory('result.events.push_back("FakeBluetooth");',known),/Unknown C\+\+ registered API/)
  assert.throws(()=>cppInventory('platform.events={dynamic_event()};',known),/Unsupported C\+\+ event inventory/)
})

test('common backend forwarding accepts only the exact native API and event grammar',()=>{
  assert.deepEqual(cppInventory('for(const auto& api:bluetooth_platform_.apis)add(api);for(const auto& event:bluetooth_platform_.events)add_event("wx.on"+event,"wx.off"+event,event);',known),[])
  assert.throws(()=>cppInventory('for(const auto& event:bluetooth_platform_.events)add_event("wx.fake"+event,"wx.off"+event,event);',known),/Unsupported C\+\+ backend vector forwarding/)
})

test('desktop host services follow declared sets through the installation sink', async () => {
  const source = await readFile(new URL('../sdk/desktop/src/host_services_adapter.cpp', import.meta.url), 'utf8')
  const names = cppInventory(source, known)
  assert.equal(names.length, 13)
  for (const name of ['wx.login', 'wx.requestPayment', 'weappContainer.identity.onChange', 'component:button.bindgetphonenumber']) assert(names.includes(name))
  assert.deepEqual(cppInventory('const std::set<std::string> unused = {"wx.login"};', known), [])
  assert.throws(() => cppInventory(source.replace('auto apis = identity_apis;', 'auto apis = unknown_apis;'), known), /Unresolved C\+\+ installed host API set/)
  assert.throws(() => cppInventory(source.replace('payment_apis.begin(), payment_apis.end()', 'unknown_apis.begin(), unknown_apis.end()'), known), /Unresolved C\+\+ inserted host API set/)
  assert.throws(() => cppInventory(source.replace('apis.insert(payment_apis.begin(), payment_apis.end())', 'apis.insert (select_api())'), known), /Unsupported C\+\+ host API insertion/)
  assert.throws(() => cppInventory(source.replace('session->register_api_handler(api)', 'session->register_host_method(api)'), known), /Unsupported C\+\+ host API installation/)
  assert.throws(() => cppInventory(source.replace('"wx.login",', '"wx.fakeLogin",'), known), /Unknown C\+\+ registered API/)
  assert.throws(() => cppInventory(source.replace('"wx.login",', 'computed_api(),'), known), /Nonliteral C\+\+ host API set/)
})
