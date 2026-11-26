import { expectAssignable } from 'tsd'
import { AgentError } from '@weapp-container/agent'

expectAssignable<Error>(new AgentError('ERR_TEST', 'test'))
