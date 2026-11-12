import React, {useEffect, useRef, useState} from 'react';
import {Button, DevSettings, SafeAreaView, Text, View} from 'react-native';
import {WeappContainerController, WeappContainerView, closeAllContainers, type JSONValue, type JSONObject} from '@weapp-container/react-native';

const refreshMarker = 'baseline';

// Both hosts load the exact portable acceptance pack. There is no web view.
export default function App() {
  const [first, setFirst] = useState<WeappContainerController>();
  const [second, setSecond] = useState<WeappContainerController>();
  const [mounted, setMounted] = useState(true);
  const [mountKey, remount] = useState(0);
  const [render, rerender] = useState(0);
  const [status, setStatus] = useState('creating');
  const [receipt, setReceipt] = useState('{}');
  const observations = useRef<Record<string, unknown>>({messages: {}, presented: 0, cancelled: 0, hostCalls: 0});
  const firstRef = useRef<WeappContainerController | undefined>(undefined);
  const cleanup = useRef(Promise.resolve());
  const key = useRef('rn-consumer');
  const publish = () => setReceipt(JSON.stringify(observations.current));
  const run = (name: string, operation: () => Promise<void>) => {
    setStatus(`running:${name}`);
    void operation().then(() => { publish(); setStatus(`passed:${name}`); }).catch(error => { observations.current.error = String(error); publish(); setStatus(`failed:${name}:${String(error)}`); });
  };
  const prepare = async (storageKey: string, label: string) => {
    const controller = await WeappContainerController.create({storage: {key: storageKey}});
    controller.subscribe(event => {
      if (event.type === 'presented') {
        observations.current.presented = Number(observations.current.presented) + 1;
        if (!observations.current[`${label}Presented`]) {
          observations.current[`${label}Presented`] = event.payload;
          void controller.capabilities().then(value => { observations.current[`${label}GpuCapabilities`] = value; publish(); });
        }
      }
      if (event.type === 'error') observations.current.nativeError = event.payload;
      if (event.type === 'navigation') observations.current.navigation = event.payload;
      if (event.type === 'message' && event.payload && typeof event.payload === 'object') {
        const value = event.payload as JSONObject;
        (observations.current.messages as Record<string, unknown>)[`${label}:${String(value.kind)}`] = value;
      }
      publish();
    });
    await controller.registerHostMethod('native.echo', async payload => { observations.current.hostCalls = Number(observations.current.hostCalls) + 1; return {native: true, payload}; });
    await controller.registerHostMethod('native.delayed', async payload => { await new Promise(resolve => setTimeout(resolve, 150)); return payload; });
    await controller.registerHostMethod('host.echo', async payload => payload);
    await controller.registerHostMethod('host.hang', (_payload, {signal}) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { observations.current.cancelled = Number(observations.current.cancelled) + 1; publish(); reject(new Error('cancelled')); }, {once: true});
    }));
    return controller;
  };
  useEffect(() => {
    let disposed = false;
    void (async () => {
      await cleanup.current;
      if (disposed) return;
      observations.current = {messages: {}, presented: 0, cancelled: 0, hostCalls: 0};
      setStatus('creating'); setFirst(undefined); setSecond(undefined); publish();
      const a = await prepare(key.current, 'first');
      if (disposed) { await a.close(); return; }
      let b: WeappContainerController;
      try { b = await prepare(`${key.current}-second`, 'second'); }
      catch (error) { await a.close(); throw error; }
      if (disposed) { await Promise.all([a.close(), b.close()]); return; }
      firstRef.current = a; setFirst(a); setSecond(b);
      await Promise.all([a.load({asset: 'acceptance-pack'}), b.load({asset: 'acceptance-pack'})]);
      observations.current.session = a.sessionId;
      observations.current.capabilities = await a.capabilities();
      observations.current.secondCapabilities = await b.capabilities();
      await a.sendMessage({op: 'inspect'});
      await a.sendMessage({op: 'echo', value: {from: 'react-native'}});
      await a.sendMessage({op: 'hang'});
      publish(); setStatus('ready');
    })().catch(error => { setStatus(`failed:create:${String(error)}`); });
    return () => { disposed = true; cleanup.current = closeAllContainers(); void cleanup.current.catch(console.error); };
  }, []);
  const current = () => { if (!firstRef.current) throw new Error('No active session'); return firstRef.current; };
  const action = (title: string, body: () => Promise<void>) => <Button key={title} title={title} testID={title} onPress={() => run(title, body)} />;
  return <SafeAreaView style={{flex: 1, backgroundColor: '#fff'}}>
    <Text testID="refresh-marker" accessibilityLabel={refreshMarker}>{refreshMarker}</Text>
    <Text testID="status" accessibilityLabel={status}>{status}</Text>
    <Text testID="receipt" accessibilityLabel={receipt} numberOfLines={2} style={{fontSize: 8}}>{receipt}</Text>
    <View style={{height: 280, marginHorizontal: 16}} testID="primary-area">
      {first && mounted && <WeappContainerView key={mountKey} controller={first} testID="container-main" style={{flex: 1}} onSurfaceError={error => setStatus(`failed:surface:${error.message}`)} />}
    </View>
    <View style={{height: 72, margin: 16}}>{second && <WeappContainerView controller={second} testID="container-second" style={{flex: 1}} />}</View>
    <View style={{flexDirection: 'row', flexWrap: 'wrap'}}>
      {__DEV__ && <Button title="ReloadRuntime" testID="ReloadRuntime" onPress={() => DevSettings.reload()} />}
      {action('Rerender', async () => { rerender(render + 1); if (current().sessionId !== observations.current.session) throw new Error('Session changed on rerender'); })}
      {action('RapidRemount', async () => { for (let i = 0; i < 12; i++) { remount(value => value + 1); await new Promise(resolve => setTimeout(resolve, 32)); } observations.current.rapidRemountSession = current().sessionId; })}
      {action('Navigate', async () => { await current().navigate('pages/detail/index', {source: 'rn'}); observations.current.state = await current().state(); })}
      {action('Back', async () => { await current().back(); observations.current.state = await current().state(); })}
      {action('Detach', async () => { setMounted(false); observations.current.detachedSession = current().sessionId; await current().sendMessage({kind: 'hidden'}); })}
      {action('Reattach', async () => { setMounted(true); observations.current.reattachedSession = current().sessionId; await current().sendMessage({op: 'inspect'}); })}
      {action('Pause', async () => { await current().setForeground(false); observations.current.pausedState = await current().state(); })}
      {action('Resume', async () => { await current().setForeground(true); observations.current.resumedState = await current().state(); })}
      {action('Close', async () => { await current().flushStorage(); await current().close(); firstRef.current = undefined; setFirst(undefined); observations.current.closed = true; })}
      {action('Reopen', async () => { const a = await prepare(key.current, 'reopened'); firstRef.current = a; setFirst(a); setMounted(true); await a.load({asset: 'acceptance-pack'}); observations.current.reopened = a.sessionId; })}
      {action('Finish', async () => { await closeAllContainers(); setFirst(undefined); setSecond(undefined); observations.current.allClosed = true; })}
    </View>
  </SafeAreaView>;
}
