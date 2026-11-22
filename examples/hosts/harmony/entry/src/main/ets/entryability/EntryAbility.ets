import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import { abilityLifecycle } from '../session/AbilityLifecycle';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want): void {
    abilityLifecycle.reset();
    // A recreated Ability must not inherit an earlier launch's route/engine.
    AppStorage.setOrCreate('weappContainerEngine', 'quickjs');
    AppStorage.setOrCreate('weappContainerRoute', '');
    AppStorage.setOrCreate('weappContainerSessionId', '');
    AppStorage.setOrCreate('weappContainerFixtureId', 'portable-pack-reference-v1');
    AppStorage.setOrCreate('weappContainerSmoke', false);
    const parameters = want.parameters;
    if (parameters !== undefined) {
      const engine = parameters['weappContainerEngine'];
      const route = parameters['weappContainerRoute'];
      const sessionId = parameters['weappContainerSessionId'];
      const fixtureId = parameters['weappContainerFixtureId'];
      const smoke = parameters['weappContainerSmoke'];
      if (typeof engine === 'string') AppStorage.setOrCreate('weappContainerEngine', engine);
      if (typeof route === 'string') AppStorage.setOrCreate('weappContainerRoute', route);
      if (typeof sessionId === 'string') AppStorage.setOrCreate('weappContainerSessionId', sessionId);
      if (typeof fixtureId === 'string') AppStorage.setOrCreate('weappContainerFixtureId', fixtureId);
      if (typeof smoke === 'boolean') AppStorage.setOrCreate('weappContainerSmoke', smoke);
    }
  }

  onForeground(): void { abilityLifecycle.setForeground(true); }

  onBackground(): void { abilityLifecycle.setForeground(false); }

  onDestroy(): void { abilityLifecycle.destroy(); }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        console.error(`Weapp Container loadContent failed: ${error.code}`);
      }
    });
  }
}
