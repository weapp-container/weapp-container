import { expectType, expectError } from 'tsd'
import { buildManifest, parseWxml, packContainer, type BuildResult, type WxmlDocument } from '@sonofmagic/container-manifest'
import { compileWxsModule } from '@sonofmagic/container-manifest/wxs-compiler'

expectType<Promise<BuildResult>>(buildManifest('.'))
expectType<WxmlDocument>(parseWxml('<view/>'))
expectType<string>(compileWxsModule('module.exports = 1').code)
expectError(packContainer('.', './out', { platform: 123 }))
