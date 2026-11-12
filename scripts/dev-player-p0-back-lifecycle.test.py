#!/usr/bin/env python3
"""Pure no-device counterexamples for the proposed navigateBack evidence validator."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
spec=importlib.util.spec_from_file_location('back_driver',Path(__file__).with_name('dev-player-p0-android.py'))
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
spec=importlib.util.spec_from_file_location('base_validators',Path(__file__).with_name('dev-player-p0-android.test.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)

def geometry(result):
    state=driver.native_state(result)
    return {'window':copy.deepcopy(state['acceptedLayout']['windowMetrics']),
            'capsule':copy.deepcopy(state['acceptedLayout']['chrome']['menuButtonRect'])}
def own(sequence,event,index=0):return json.dumps({'sequence':sequence,'event':event,'geometry':index,'detail':None})
def event(sequence,kind,instance,name,index):return json.dumps([sequence,kind,instance,name,index,None])

def samples():
    after=base.fixture();before=copy.deepcopy(after)
    old=before['snapshot']['state'];old['page']={'id':2,'route':'pages/custom/index'}
    old['acceptedLayout']['chrome']['pageId']=2
    old['acceptedLayout']['windowMetrics'].update(windowHeight=850,screenTop=0)
    old['acceptedLayout']['chrome']['contentRect'].update(top=0,height=850)
    old['viewport']['height']=850;old['observedViewport']['height']=850
    old['acceptedLayout']['observationId']='8';old['acceptedLayout']['layoutRevision']='11'
    new=after['snapshot']['state'];new['acceptedLayout']['observationId']='9';new['acceptedLayout']['layoutRevision']='12'
    home_geometry,custom_geometry=geometry(after),geometry(before)
    geometries=[json.dumps(home_geometry),json.dumps(custom_geometry)]
    events=[event(1,'home',1,'onLoad',0),event(2,'home',1,'onShow',0),event(3,'home',1,'onReady',0),
            event(4,'home',1,'onHide',0),event(5,'custom',2,'onLoad',1),event(6,'custom',2,'onShow',1),
            event(7,'custom',2,'onReady',1),event(8,'custom',2,'onResize',1),
            event(9,'custom',2,'onHide',1),event(10,'custom',2,'onShow',1)]
    home={'kind':'home','instance':1,'events':[own(1,'onLoad'),own(2,'onShow'),own(3,'onReady'),own(4,'onHide')],
          'geometries':[json.dumps(home_geometry)],'first':{'sequence':1,'event':'onLoad','geometry':0,'detail':None},'journal':None}
    custom={'kind':'custom','instance':2,'events':[own(5,'onLoad'),own(6,'onShow'),own(7,'onReady'),own(8,'onResize'),own(9,'onHide'),own(10,'onShow')],
          'geometries':[json.dumps(custom_geometry)],'first':{'sequence':5,'event':'onLoad','geometry':0,'detail':None},
          'journal':{'schemaVersion':1,'events':copy.deepcopy(events),'geometries':copy.deepcopy(geometries)}}
    before['snapshot']['pages']=[{'id':1,'route':'pages/home/index','data':copy.deepcopy(home)},{'id':2,'route':'pages/custom/index','data':custom}]
    retired=copy.deepcopy(custom);retired['events'] += [own(11,'navigateBack'),own(12,'onUnload')]
    retired.pop('journal')
    home['lastRetired']=retired;home['events'].append(own(13,'onShow'))
    home['journal']={'schemaVersion':1,'events':events+[event(11,'custom',2,'navigateBack',1),event(12,'custom',2,'onUnload',1),event(13,'home',1,'onShow',0)],'geometries':geometries}
    after['snapshot']['pages'][0]['data']=home
    return before,after,10

def current(after):return after['snapshot']['pages'][-1]['data']
def change_event(after,index,mutate):
    values=current(after)['journal']['events'];item=json.loads(values[index]);mutate(item);values[index]=json.dumps(item)

class BackLifecycle(unittest.TestCase):
    def test_valid_back_has_one_unload_with_old_geometry_then_existing_home_show_with_new_geometry(self):
        before,after,boundary=samples();r=driver.require_back_lifecycle(before,after,boundary)
        self.assertEqual((r['unloadSequence'],r['onShowSequence']),(12,13))
        self.assertEqual(r['exitGeometry']['window']['windowHeight'],850)
        self.assertEqual(r['destinationGeometry']['window']['windowHeight'],700)
    def test_prior_activity_hide_show_remains_retained_but_cannot_satisfy_navigation(self):
        before,after,boundary=samples();driver.require_back_lifecycle(before,after,boundary)
        self.assertIn('onHide',[json.loads(e)[3] for e in current(after)['journal']['events'] if json.loads(e)[0]<=boundary])
    def test_new_onhide_is_rejected_even_if_unload_exists(self):
        before,after,boundary=samples();values=current(after)['journal']['events'];values.insert(-1,event(13,'custom',2,'onHide',1));change_event(after,-1,lambda e:e.__setitem__(0,14))
        with self.assertRaisesRegex(RuntimeError,'no departing onHide'):driver.require_back_lifecycle(before,after,boundary)
    def test_missing_unload_is_rejected(self):
        before,after,boundary=samples();change_event(after,-2,lambda e:e.__setitem__(3,'onReady'))
        with self.assertRaisesRegex(RuntimeError,'exactly one'):driver.require_back_lifecycle(before,after,boundary)
    def test_duplicate_unload_is_rejected(self):
        before,after,boundary=samples();current(after)['journal']['events'].insert(-1,event(13,'custom',2,'onUnload',1));change_event(after,-1,lambda e:e.__setitem__(0,14))
        with self.assertRaisesRegex(RuntimeError,'exactly one'):driver.require_back_lifecycle(before,after,boundary)
    def test_other_page_unload_does_not_satisfy_departing_instance(self):
        before,after,boundary=samples();change_event(after,-2,lambda e:e.__setitem__(2,9))
        with self.assertRaisesRegex(RuntimeError,'exactly one'):driver.require_back_lifecycle(before,after,boundary)
    def test_missing_back_click_record_is_rejected(self):
        before,after,boundary=samples();change_event(after,-3,lambda e:e.__setitem__(3,'increment.begin'))
        with self.assertRaisesRegex(RuntimeError,'Back click'):driver.require_back_lifecycle(before,after,boundary)
    def test_unload_cannot_read_destination_geometry(self):
        before,after,boundary=samples();change_event(after,-2,lambda e:e.__setitem__(4,0))
        with self.assertRaisesRegex(RuntimeError,'geometry mismatch'):driver.require_back_lifecycle(before,after,boundary)
    def test_unload_cannot_omit_window_or_capsule_fields(self):
        for field in ['windowWidth','pixelRatio']:
            before,after,boundary=samples();g=json.loads(current(after)['journal']['geometries'][1]);del g['window'][field];current(after)['journal']['geometries'][1]=json.dumps(g)
            with self.subTest(field=field),self.assertRaises(RuntimeError):driver.require_back_lifecycle(before,after,boundary)
    def test_unload_mixed_capsule_is_rejected(self):
        before,after,boundary=samples();g=json.loads(current(after)['journal']['geometries'][1]);g['capsule']['left']+=1;current(after)['journal']['geometries'][1]=json.dumps(g)
        with self.assertRaisesRegex(RuntimeError,'capsule'):driver.require_back_lifecycle(before,after,boundary)
    def test_home_show_cannot_read_departing_geometry(self):
        before,after,boundary=samples();change_event(after,-1,lambda e:e.__setitem__(4,1))
        with self.assertRaisesRegex(RuntimeError,'geometry mismatch'):driver.require_back_lifecycle(before,after,boundary)
    def test_show_before_unload_is_rejected(self):
        before,after,boundary=samples();v=current(after)['journal']['events'];v[-3:]=[event(11,'home',1,'onShow',0),event(12,'custom',2,'navigateBack',1),event(13,'custom',2,'onUnload',1)]
        with self.assertRaisesRegex(RuntimeError,'after unloading'):driver.require_back_lifecycle(before,after,boundary)
    def test_duplicate_home_show_is_rejected(self):
        before,after,boundary=samples();current(after)['journal']['events'].append(event(14,'home',1,'onShow',0))
        with self.assertRaisesRegex(RuntimeError,'exactly once'):driver.require_back_lifecycle(before,after,boundary)
    def test_retired_geometry_cannot_disagree_with_cross_page_journal(self):
        before,after,boundary=samples();ret=current(after)['lastRetired'];g=json.loads(ret['geometries'][0]);g['window']['windowHeight']=1;ret['geometries'][0]=json.dumps(g)
        with self.assertRaisesRegex(RuntimeError,'Retired onUnload geometry'):driver.require_back_lifecycle(before,after,boundary)
    def test_destination_own_journal_cannot_disagree(self):
        before,after,boundary=samples();show=json.loads(current(after)['events'][-1]);show['event']='onReady';current(after)['events'][-1]=json.dumps(show)
        with self.assertRaisesRegex(RuntimeError,'both page'):driver.require_back_lifecycle(before,after,boundary)
    def test_prior_journal_cannot_be_lost_or_rewritten(self):
        for mode in ['lost','rewritten']:
            before,after,boundary=samples()
            if mode=='lost':current(after)['journal']['events'].pop(0)
            else:change_event(after,0,lambda e:e.__setitem__(3,'corrupt'))
            with self.subTest(mode=mode),self.assertRaisesRegex(RuntimeError,'lost or rewrote'):driver.require_back_lifecycle(before,after,boundary)
    def test_boundary_must_be_actual_last_preclick_sequence(self):
        for boundary in [9,11]:
            before,after,_=samples()
            with self.subTest(boundary=boundary),self.assertRaisesRegex(RuntimeError,'pre-click'):driver.require_back_lifecycle(before,after,boundary)
    def test_destination_stack_and_instance_must_be_retained(self):
        before,after,boundary=samples();current(after)['instance']=9
        with self.assertRaisesRegex(RuntimeError,'existing home'):driver.require_back_lifecycle(before,after,boundary)
    def test_retired_page_identity_must_match(self):
        before,after,boundary=samples();current(after)['lastRetired']['first']['sequence']=1
        with self.assertRaisesRegex(RuntimeError,'departing page'):driver.require_back_lifecycle(before,after,boundary)
    def test_stale_layout_revision_is_rejected(self):
        before,after,boundary=samples();after['snapshot']['state']['acceptedLayout']['layoutRevision']='11'
        with self.assertRaisesRegex(RuntimeError,'stale'):driver.require_back_lifecycle(before,after,boundary)
    def test_retired_duplicate_unload_is_rejected(self):
        before,after,boundary=samples();current(after)['lastRetired']['events'].append(own(14,'onUnload'))
        with self.assertRaisesRegex(RuntimeError,'unload journals disagree'):driver.require_back_lifecycle(before,after,boundary)
    def test_retired_only_onhide_cannot_hide_from_global_journal(self):
        before,after,boundary=samples();current(after)['lastRetired']['events'].append(own(14,'onHide'))
        with self.assertRaisesRegex(RuntimeError,'unload journals disagree'):driver.require_back_lifecycle(before,after,boundary)
    def test_retired_prior_callbacks_cannot_be_rewritten(self):
        before,after,boundary=samples();current(after)['lastRetired']['events'][0]=own(5,'corrupt')
        with self.assertRaisesRegex(RuntimeError,'lost or rewrote departing'):driver.require_back_lifecycle(before,after,boundary)
    def test_same_page_count_with_different_destination_stack_is_rejected(self):
        before,after,boundary=samples();page=after['snapshot']['pages'][0];page['id']=3;state=after['snapshot']['state'];state['page']['id']=3;state['acceptedLayout']['chrome']['pageId']=3
        with self.assertRaisesRegex(RuntimeError,'preserve the destination stack'):driver.require_back_lifecycle(before,after,boundary)
    def test_duplicate_or_nonmonotonic_sequence_is_rejected(self):
        before,after,boundary=samples();change_event(after,-1,lambda e:e.__setitem__(0,12))
        with self.assertRaisesRegex(RuntimeError,'increase'):driver.require_back_lifecycle(before,after,boundary)

if __name__=='__main__':unittest.main()
