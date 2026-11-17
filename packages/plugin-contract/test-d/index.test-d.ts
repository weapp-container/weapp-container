import { expectAssignable, expectType } from 'tsd'
import { definePlugin, PLUGIN_PROTOCOL_VERSION, type PluginManifest } from '@weapp-container/plugin-contract'

const manifest = definePlugin({
  id: 'fixture',
  version: '1.0.0',
  protocolVersion: PLUGIN_PROTOCOL_VERSION,
  apis: [{
    name: 'weappContainer.plugin.fixture.run',
    kind: 'async',
    owner: 'plugin',
    support: 'full',
  }],
})

expectType<Readonly<typeof manifest>>(manifest)
expectAssignable<PluginManifest>(manifest)
