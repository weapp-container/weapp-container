export const PLUGIN_PROTOCOL_VERSION = 1 as const

export type PluginCapability = 'full' | 'partial' | 'unsupported'

export interface PluginApiDescriptor {
  name: string
  kind: string
  owner: 'plugin'
  support: PluginCapability
  permission?: string
  factory?: string
  objectType?: string
  event?: string
  counterpart?: string
  metadata?: Record<string, unknown>
}

export interface PluginManifest {
  id: string
  version: string
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION
  apis?: readonly PluginApiDescriptor[]
  componentNamespaces?: readonly string[]
}

const idPattern = /^[a-z][a-z0-9_]{0,47}$/
const identifierPattern = /^[A-Za-z][A-Za-z0-9_]*$/

export function validatePluginManifest(input: PluginManifest): PluginManifest {
  if (!input || typeof input !== 'object') throw new TypeError('plugin manifest must be an object')
  if (!idPattern.test(input.id)) throw new TypeError('plugin id must be lowercase ASCII and start with a letter')
  if (typeof input.version !== 'string' || input.version.length === 0 || input.version.length > 128) {
    throw new TypeError('plugin version must be a nonempty string of at most 128 bytes')
  }
  if (input.protocolVersion !== PLUGIN_PROTOCOL_VERSION) throw new TypeError('unsupported plugin protocol version')

  const prefix = `weappContainer.plugin.${input.id}.`
  const names = new Set<string>()
  for (const api of input.apis ?? []) {
    if (!api || api.owner !== 'plugin' || !api.name.startsWith(prefix)) throw new TypeError(`plugin API must use ${prefix}`)
    const suffix = api.name.slice(prefix.length)
    if (!suffix || !suffix.split('.').every(part => identifierPattern.test(part))) throw new TypeError(`invalid plugin API name: ${api.name}`)
    if (names.has(api.name)) throw new TypeError(`duplicate plugin API: ${api.name}`)
    names.add(api.name)
    if (!['full', 'partial', 'unsupported'].includes(api.support)) throw new TypeError(`invalid capability for ${api.name}`)
  }

  const namespacePrefix = `plugin://${input.id}/`
  const namespaces = new Set<string>()
  for (const namespace of input.componentNamespaces ?? []) {
    if (!namespace.startsWith(namespacePrefix) || namespace.length === namespacePrefix.length) {
      throw new TypeError(`component namespace must stay under ${namespacePrefix}`)
    }
    if (namespaces.has(namespace)) throw new TypeError(`duplicate component namespace: ${namespace}`)
    namespaces.add(namespace)
  }

  return Object.freeze({
    ...input,
    apis: Object.freeze([...(input.apis ?? [])].map(api => Object.freeze({ ...api }))),
    componentNamespaces: Object.freeze([...(input.componentNamespaces ?? [])]),
  })
}

export function definePlugin<const T extends PluginManifest>(manifest: T): Readonly<T> {
  return validatePluginManifest(manifest) as Readonly<T>
}
