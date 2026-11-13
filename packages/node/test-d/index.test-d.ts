import { expectType, expectError } from 'tsd'
import { createContainer, type Container, type FlushResult } from '@weapp-container/node'
import { packArtifact, type ContainerArtifact } from '@weapp-container/node/artifact'

expectType<Promise<Container>>(createContainer({ nowMs: 0 }))
expectType<Promise<ContainerArtifact>>(packArtifact({ projectPath: '.' }))
expectError(createContainer({ nowMs: '0' }))
const container = await createContainer()
const page = await container.renderPage('/pages/index')
expectType<Promise<number>>(page.data<number>('count'))
expectType<Promise<FlushResult>>(container.flush())
expectType<Promise<void>>((await page.query('#button'))!.tap())
expectType<Promise<void>>(container[Symbol.asyncDispose]())
