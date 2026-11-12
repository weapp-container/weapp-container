import React, {createContext, useContext, useEffect, useRef, useState} from 'react';
import {Button, SafeAreaView, ScrollView, Text, View} from 'react-native';
import {NavigationContainer, createNavigationContainerRef} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {WeappContainerController, WeappContainerView, type JSONObject} from '@weapp-container/react-native';

type Routes = {Embedded: undefined; Other: undefined};
const Stack = createNativeStackNavigator<Routes>();
const navigation = createNavigationContainerRef<Routes>();
type Host = {controller?: WeappContainerController; observe(name: string, value: unknown): void; scroll: React.RefObject<React.ElementRef<typeof ScrollView> | null>};
const HostContext = createContext<Host>(null!);
function EmbeddedScreen() {
  const {controller, observe, scroll} = useContext(HostContext);
  return <ScrollView ref={scroll} testID="host-scroll" scrollEventThrottle={16} onScroll={event => observe('parentOffset', event.nativeEvent.contentOffset.y)}>
    <View testID="parent-drag-area" style={{height: 120, backgroundColor: '#ede7d9', padding: 20}}><Text>Host scroll area</Text></View>
    <View style={{height: 380, margin: 16}}>
      {controller && <WeappContainerView controller={controller} testID="host-container" style={{flex: 1}} onSurfaceError={error => observe('surfaceError', error)} />}
    </View>
    <View testID="parent-footer" style={{height: 900, padding: 20, backgroundColor: '#ede7d9'}}><Text>Host content below the native mini-program</Text></View>
  </ScrollView>;
}
function OtherScreen() { return <View testID="other-route" style={{flex: 1, backgroundColor: '#def2e8', padding: 24}}><Text>Another native host route</Text></View>; }

/** Separate acceptance harness: the SDK package and the public example stay unchanged. */
export default function App() {
  const [controller, setController] = useState<WeappContainerController>();
  const [receipt, setReceipt] = useState('{}');
  const [status, setStatus] = useState('creating');
  const facts = useRef<Record<string, any>>({messages: {}, touchEvents: [], presented: 0, parentOffset: 0, hostRoute: 'Embedded'});
  const owner = useRef<WeappContainerController | undefined>(undefined);
  const scroll = useRef<React.ElementRef<typeof ScrollView>>(null);
  const pushOnTouch = useRef(false);
  const publish = () => setReceipt(JSON.stringify(facts.current));
  const observe = (name: string, value: unknown) => { facts.current[name] = value; publish(); };
  const run = (name: string, operation: () => Promise<void>) => {
    setStatus(`running:${name}`);
    void operation().then(() => { publish(); setStatus(`passed:${name}`); }).catch(error => { observe('error', String(error)); setStatus(`failed:${name}:${String(error)}`); });
  };
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const session = await WeappContainerController.create({storage: {key: 'rn-host-gestures'}});
      owner.current = session;
      if (disposed) { await session.close(); return; }
      session.subscribe(event => {
        if (event.type === 'presented') {
          facts.current.presented++;
          if (!facts.current.gpu) void session.capabilities().then(value => observe('gpu', value));
        }
        if (event.type === 'error') facts.current.nativeError = event.payload;
        if (event.type === 'message' && event.payload && typeof event.payload === 'object') {
          const value = event.payload as JSONObject;
          facts.current.messages[String(value.kind)] = value;
          if (value.kind === 'touch') {
            facts.current.touchEvents.push(value);
            if (value.type === 'touchstart' && pushOnTouch.current) {
              pushOnTouch.current = false;
              facts.current.pushTriggeredByTouch = true;
              navigation.dispatch({type: 'PUSH', payload: {name: 'Other'}});
            }
          }
        }
        publish();
      });
      await session.registerHostMethod('native.echo', payload => payload);
      setController(session);
      await session.load({asset: 'acceptance-pack'});
      facts.current.session = session.sessionId;
      await session.sendMessage({op: 'inspect'});
      facts.current.state = await session.state();
      publish(); setStatus('ready');
    })().catch(error => { observe('error', String(error)); setStatus(`failed:create:${String(error)}`); });
    return () => { disposed = true; pushOnTouch.current = false; void owner.current?.close().catch(console.error); };
  }, []);
  const session = () => { if (!owner.current) throw new Error('Session is unavailable'); return owner.current; };
  const push = () => navigation.dispatch({type: 'PUSH', payload: {name: 'Other'}});
  const action = (name: string, operation: () => Promise<void>) => <Button key={name} testID={name} title={name} onPress={() => run(name, operation)} />;
  return <SafeAreaView style={{flex: 1, backgroundColor: '#fff'}}>
    <Text testID="host-status" accessibilityLabel={status}>{status}</Text>
    <Text testID="host-receipt" accessibilityLabel={receipt} numberOfLines={2} style={{fontSize: 8}}>{receipt}</Text>
    <View style={{flexDirection: 'row', flexWrap: 'wrap'}}>
      {action('PushHost', async () => { push(); })}
      {action('PopHost', async () => { navigation.goBack(); })}
      {action('ArmPush', async () => { pushOnTouch.current = true; })}
      {action('ResetParent', async () => { scroll.current?.scrollTo({y: 0, animated: false}); })}
      {action('Inspect', async () => { facts.current.state = await session().state(); await session().sendMessage({op: 'inspect'}); })}
      {action('MiniDetail', async () => { await session().navigate('pages/detail/index', {from: 'host-harness'}); facts.current.state = await session().state(); await session().sendMessage({op: 'inspect'}); })}
      {action('Finish', async () => { await session().close(); setController(undefined); facts.current.closed = true; })}
    </View>
    <HostContext.Provider value={{controller, observe, scroll}}>
      <NavigationContainer ref={navigation} onStateChange={() => observe('hostRoute', navigation.getCurrentRoute()?.name)}>
        <Stack.Navigator screenOptions={{headerShown: false}}>
          <Stack.Screen name="Embedded" component={EmbeddedScreen} />
          <Stack.Screen name="Other" component={OtherScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </HostContext.Provider>
  </SafeAreaView>;
}
