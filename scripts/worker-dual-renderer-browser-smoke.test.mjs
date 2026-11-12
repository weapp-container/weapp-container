import assert from 'node:assert/strict'
import test from 'node:test'
import { assertAccepted, sampleSettledAppState } from './worker-dual-renderer-browser-smoke.mjs'

function fixture(profile) {
  const path = profile === 'webview' ? 'pages/dom/index' : 'pages/skia/index'
  const transportBackend = profile === 'webview' ? 'browser-view' : 'external-frame'
  const runtimeOwner = {workerEpoch:'worker-fixture', sessionId:'session-fixture', packSha256:'a'.repeat(64)}
  const binding = {version:'1.0', sessionId:runtimeOwner.sessionId, generation:'3', transportBackend}
  const owner = {...runtimeOwner, transportBackend, presenterGeneration:binding.generation}
  const viewport = {x:0, y:0, width:375, height:667}
  const proof = {version:'1.0', owner:structuredClone(owner), surfaceGeneration:'7',
    consumedInput:{pageId:'4', routePath:path, templateRevision:'40', viewport:structuredClone(viewport)},
    publication:transportBackend === 'external-frame' ? {kind:transportBackend,renderRevision:'19'} : {kind:transportBackend,
      key:{sessionId:runtimeOwner.sessionId,pageId:'4',documentRevision:'11',presentationRevision:'12',surfaceGeneration:'7',profile:'webview'}}}
  return {path, status:{phase:'ready',runtimeReady:true,inputEnabled:true,runtimeOwner,owner,presenterBinding:binding,
    presenterTransition:null,observation:{version:'2.0',sequence:'55',state:{owner:structuredClone(runtimeOwner),
      currentPage:{pageId:'4',path},rendererProfile:profile,presenterBinding:structuredClone(binding),
      transitionRequired:false,templateRevision:'40',surfaceGeneration:'7',viewport}},
    presentation:{accepted:{inputEnabled:true,proof}}}}
}

function samplerFixture(profile) {
  const {path, status} = fixture(profile)
  const state = {path, status, reads:0, waits:0, clock:0,
    app:{pages:[{route:path,ready:true,count:1,resizeCount:0,instance:1}]}}
  state.update = change => { const next = structuredClone(state.status); change(next); state.status = next }
  state.dependencies = {
    session:{get status() { return state.status }, async request(op, payload) {
      assert.equal(op,'module.call'); assert.equal(payload.export,'dualRendererSmokeState')
      state.reads++
      return state.onRead ? state.onRead() : {ok:true,result:[structuredClone(state.app)]}
    }},
    now:() => state.clock,
    wait:async milliseconds => { state.clock += milliseconds; state.waits++; state.onWait?.() },
  }
  state.sample = () => sampleSettledAppState({moduleId:'module:app.js',route:path,count:1,timeoutMs:120,pollMs:40},state.dependencies)
  return state
}

for (const profile of ['webview','skia']) {
  test(`${profile}: onReady racing a business read waits passively for the exact successor proof`, async () => {
    const state = samplerFixture(profile)
    state.onRead = () => {
      state.update(status => { status.observation.sequence = '56'; status.observation.state.templateRevision = '41' })
      return {ok:true,result:[structuredClone(state.app)]}
    }
    state.onWait = () => {
      assert.equal(state.reads,1,'Pending presentation must not invoke application code again')
      state.update(status => { status.presentation.accepted.proof.consumedInput.templateRevision = '41' })
    }
    const result = await state.sample()
    assert.equal(state.reads,1); assert.equal(state.waits,1)
    assert.equal(result.status.observation.state.templateRevision,'41')
    assert.equal(result.status,state.status,'Status is captured with the retained business result in the same sampling task')
    assert.deepEqual(result.app,state.app)
    assertAccepted(result.status,state.path,'settled after onReady')
  })

  test(`${profile}: a retained business result never grants an older presentation proof`, async () => {
    const state = samplerFixture(profile)
    state.onRead = () => {
      state.update(status => { status.observation.sequence = '56'; status.observation.state.templateRevision = '41' })
      return {ok:true,result:[structuredClone(state.app)]}
    }
    await assert.rejects(state.sample(),/ERR_TIMEOUT: exact accepted application snapshot/)
    assert.equal(state.reads,1); assert.equal(state.waits,3)
    assert.throws(() => assertAccepted(state.status,state.path,'unsettled'),assert.AssertionError)
  })

  test(`${profile}: unmet business conditions only re-read after genuine observation progress`, async () => {
    const state = samplerFixture(profile)
    state.onRead = () => ({ok:true,result:[{pages:[{...state.app.pages[0],count:state.reads === 1 ? 0 : 1}]}]})
    state.onWait = () => {
      assert.equal(state.reads,1,'A passive poll must not call the fixture export')
      if (state.waits === 2) state.update(status => {
        status.observation.sequence = '56'; status.observation.state.templateRevision = '41'
      })
      if (state.waits === 3) state.update(status => { status.presentation.accepted.proof.consumedInput.templateRevision = '41' })
    }
    // Allow one extra passive turn for the queued input and its presentation.
    const result = await sampleSettledAppState({moduleId:'module:app.js',route:state.path,count:1,timeoutMs:160,pollMs:40},state.dependencies)
    assert.equal(state.reads,2); assert.equal(state.waits,3); assert.equal(result.app.pages[0].count,1)
    assertAccepted(result.status,state.path,'settled after actual input')
  })

  test(`${profile}: a new instance of the same route cannot borrow the retired page business result`, async () => {
    const state = samplerFixture(profile)
    state.onRead = () => {
      if (state.reads === 1) state.update(status => {
        status.observation.sequence = '56'; status.observation.state.templateRevision = '41'
      })
      return {ok:true,result:[{pages:[{...state.app.pages[0],instance:state.reads}]}]}
    }
    state.onWait = () => state.update(status => {
      status.observation.sequence = '57'; status.observation.state.currentPage.pageId = '5'
      status.observation.state.templateRevision = '42'
      status.presentation.accepted.proof.consumedInput.pageId = '5'
      status.presentation.accepted.proof.consumedInput.templateRevision = '42'
    })
    const result = await state.sample()
    assert.equal(state.reads,2); assert.equal(result.app.pages[0].instance,2)
    assert.equal(result.status.observation.state.currentPage.pageId,'5')
    assertAccepted(result.status,state.path,'new instance')
  })

  test(`${profile}: no application read occurs while the initial presentation is pending`, async () => {
    const state = samplerFixture(profile)
    state.update(status => { status.observation.state.templateRevision = '41' })
    state.onWait = () => {
      assert.equal(state.reads,0)
      state.update(status => { status.presentation.accepted.proof.consumedInput.templateRevision = '41' })
    }
    const result = await state.sample()
    assert.equal(state.reads,1); assert.equal(state.waits,1)
    assertAccepted(result.status,state.path,'initial settled snapshot')
  })

  test(`${profile}: a failed business read is preserved rather than replaced with cached success`, async () => {
    const state = samplerFixture(profile)
    state.onRead = () => ({ok:false,result:[]})
    await assert.rejects(state.sample(),/Real fixture module.call failed/)
    assert.equal(state.reads,1); assert.equal(state.waits,0)
  })

  test(`${profile}: settled stages still require the exact latest template`, () => {
    const {path,status} = fixture(profile)
    assert.doesNotThrow(() => assertAccepted(status,path,'settled'))
    status.observation.state.templateRevision = '41'
    assert.throws(() => assertAccepted(status,path,'settled'), assert.AssertionError)
    assert.doesNotThrow(() => assertAccepted(status,path,'sampled',{allowPendingTemplate:true}))
    status.presentation.accepted.proof.consumedInput.templateRevision = '42'
    assert.throws(() => assertAccepted(status,path,'sampled',{allowPendingTemplate:true}), /future template/)
  })

  test(`${profile}: pending data never permits retired page, viewport, surface or binding proof`, () => {
    const changes = [
      ['page id', value => {value.presentation.accepted.proof.consumedInput.pageId = '2'}],
      ['route', value => {value.presentation.accepted.proof.consumedInput.routePath = 'pages/retired/index'}],
      ['surface', value => {value.presentation.accepted.proof.surfaceGeneration = '6'}],
      ['viewport', value => {value.presentation.accepted.proof.consumedInput.viewport.width = 400}],
      ['presenter generation', value => {value.presentation.accepted.proof.owner.presenterGeneration = '2'}],
      ['worker', value => {value.presentation.accepted.proof.owner.workerEpoch = 'old-worker'}],
      ['session', value => {value.presentation.accepted.proof.owner.sessionId = 'old-session'}],
      ['pack', value => {value.presentation.accepted.proof.owner.packSha256 = 'b'.repeat(64)}],
      ['native binding', value => {value.observation.state.presenterBinding.generation = '2'}],
      ['family', value => {value.presentation.accepted.proof.publication.kind = profile === 'webview' ? 'external-frame' : 'browser-view'}],
      ['pending transition', value => {value.observation.state.transitionRequired = true}],
      ['unaccepted proof', value => {value.presentation.accepted.inputEnabled = false}],
    ]
    for (const [reason,change] of changes) {
      const {path,status} = fixture(profile)
      status.observation.state.templateRevision = '41'
      change(status)
      assert.throws(() => assertAccepted(status,path,reason,{allowPendingTemplate:true}), assert.AssertionError, reason)
    }
  })
}
