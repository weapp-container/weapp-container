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
    const parameters = want.parameters;
    if (parameters !== undefined) {
      const engine = parameters['weappContainerEngine'];
      const route = parameters['weappContainerRoute'];
      const sessionId = parameters['weappContainerSessionId'];
      if (typeof engine === 'string') AppStorage.setOrCreate('weappContainerEngine', engine);
      if (typeof route === 'string') AppStorage.setOrCreate('weappContainerRoute', route);
      if (typeof sessionId === 'string') AppStorage.setOrCreate('weappContainerSessionId', sessionId);
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
