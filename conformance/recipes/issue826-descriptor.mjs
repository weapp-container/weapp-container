const freeze = value => { if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)};return value }
const sourceSha256='060480ba6f466ae292552a78de6dc45c15e3699aa881356659f1fe3bbe88d099'
const source='e2e/ide/github-issues.runtime.issue826.test.ts'
const data=(ordinal,line,route)=>({kind:'data.read',ordinal,target:'Page',path:'value',options:{timeout:5000},route,sourceCallsite:source+':'+line+' Page.data'})
const checkpoint=(ordinal,id,route,selector)=>({kind:'checkpoint',ordinal,id,route,queries:[{selector,query:'css',fields:{text:true,attributes:[]}}]})
const index='pages/issue-826/index',second='pages/issue-826/second'
export const descriptor=freeze({caseId:'ide-github-issues-runtime-issue826',caseSourcePath:source,sourceSha256,
 sourceGuards:[{path:source,sha256:sourceSha256,bytes:2850},
 {path:'e2e/ide/github-issues.runtime.shared.ts',sha256:'958b47bf162ba7646bf296cb43a17f3bde3c9914430021c69121990407caebcb',bytes:53026},
 {path:'e2e/ide/runtimeErrors.ts',sha256:'58948d503f6c85d282c09154e6a1fbef786ad9336a8eeaf172de891063981e0b',bytes:8129},
 {path:'e2e/utils/automator.ts',sha256:'3389347206d95d6cbaa3fba9a0f72ab75519868032dc868810019599186f0938',bytes:116942}],
 plans:[{ordinal:0,route:index,fullName:'e2e app: github-issues / issue #826 executes preserved single, shared and barrel modules across page relaunches',steps:[
 data(0,59,index),checkpoint(0,'index',index,'#issue826-page'),
 {kind:'reLaunch',ordinal:1,route:second,sourceCallsite:source+':62 relaunchPage',sourceAcquisition:'MiniProgram.reLaunch then actual new Page'},
 data(2,72,second),checkpoint(1,'second',second,'#issue826-second-page')]}],
 runtimeLogCapture:{reset:false,subscriptionCallsite:'e2e/utils/automator.ts:2912-2934 structured enableLog',subscriptionHelperSha256:'3389347206d95d6cbaa3fba9a0f72ab75519868032dc868810019599186f0938',filter:'error-or-exception',sourceCallsite:source+':75-78 runtimeErrors'},compiledFiles:[]})
