import { expectType } from 'tsd'
import { createContainer, type Container } from '../dist/index.cjs'
import { packArtifact, type ContainerArtifact } from '../dist/artifact.cjs'

expectType<Promise<Container>>(createContainer())
expectType<Promise<ContainerArtifact>>(packArtifact({ projectPath: '.' }))
