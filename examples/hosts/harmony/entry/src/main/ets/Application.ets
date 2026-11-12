import AbilityStage from '@ohos.app.ability.AbilityStage';

export default class Application extends AbilityStage {
  onCreate(): void {
    console.info('Weapp Container application created');
  }
}
