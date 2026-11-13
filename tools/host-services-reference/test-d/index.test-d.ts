import { expectType, expectError } from 'tsd'
import { HostServices, createHostServicesServer } from '@weapp-container/host-services-reference'
import type { Server } from 'node:http'

const service = new HostServices({ identitySecret: 'a'.repeat(32), issuerSecret: 'b'.repeat(32) })
expectType<Server>(createHostServicesServer(service))
expectType<void>(service.close())
expectError(new HostServices({ identitySecret: 123 }))
