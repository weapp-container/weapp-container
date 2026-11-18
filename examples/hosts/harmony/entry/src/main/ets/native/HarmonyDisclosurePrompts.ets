import { ComponentContent } from '@ohos.arkui.node';
import { UIContext } from '@ohos.arkui.UIContext';
import { BusinessError } from '@ohos.base';
import { HarmonyDisclosureDriver, HarmonyDisclosureHandle, HarmonyDisclosureModel } from '../session/DisclosurePrompts';

class DisclosureContentModel {
  readonly identity: HarmonyDisclosureModel;
  readonly decide: (granted: boolean) => void;
  constructor(identity: HarmonyDisclosureModel, decide: (granted: boolean) => void) {this.identity=identity;this.decide=decide;}
}

@Builder
function DisclosureContent(model: DisclosureContentModel) {
  Column({space:16}) {
    Text(model.identity.kind==='phone'?'授权手机号':'授权昵称和头像').fontSize(20).fontWeight(FontWeight.Bold)
    Text(`${model.identity.appId}（${model.identity.publisherId}）`).fontSize(14)
    Text(model.identity.kind==='phone'?'允许此小程序获取宿主账号已验证的手机号？':'允许此小程序获取宿主账号的昵称和头像？').fontSize(16)
    Text(`用途：${model.identity.purpose}`).fontSize(16)
    Row({space:20}) {
      Button('拒绝').onClick(():void=>model.decide(false))
      Button('允许').onClick(():void=>model.decide(true))
    }
  }.padding(24).width('88%').backgroundColor(Color.White).borderRadius(16)
}

class ArkUIDisclosureHandle implements HarmonyDisclosureHandle {
  private readonly ui: UIContext;
  private readonly content: ComponentContent<DisclosureContentModel>;
  private readonly dismissed: () => void;
  private gone: boolean = false;
  private attempted: boolean = false;
  private disposed: boolean = false;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly disappearance: Promise<void>;
  private disappeared: () => void = ():void=>{};
  constructor(ui: UIContext, model: HarmonyDisclosureModel, decision: (granted: boolean) => void, dismissed: () => void) {
    this.ui=ui;this.dismissed=dismissed;
    this.disappearance=new Promise<void>((resolve):void=>{this.disappeared=resolve;});
    this.content=new ComponentContent(ui,wrapBuilder(DisclosureContent),new DisclosureContentModel(model,decision));
  }
  show(): Promise<void> {
    if(this.opening!==null)return this.opening;
    if(this.disposed)return Promise.reject(new Error('disclosure content already disposed'));
    this.attempted=true;
    this.opening=this.ui.getPromptAction().openCustomDialog(this.content,{
      autoCancel:true,
      onWillDismiss:(action):void=>{action.dismiss();},
      onDidDisappear:():void=>{if(this.gone)return;this.gone=true;this.disappeared();this.dismissed();},
    });return this.opening;
  }
  close(): Promise<void> {
    if(this.disposed)return Promise.resolve();if(this.closing!==null)return this.closing;
    const task=(async():Promise<void>=>{
      if(this.opening!==null)await this.opening.catch(():void=>{});
      if(this.attempted&&!this.gone){
        try{await this.ui.getPromptAction().closeCustomDialog(this.content);}
        catch(error){
          // Official 103303 means this exact content has no native dialog.
          // All other failures retain content/identity for cleanup retry.
          if((error as BusinessError).code!==103303)throw error as Error;
          this.gone=true;this.disappeared();
        }
        await this.disappearance;
      }
      this.content.dispose();this.disposed=true;
    })();this.closing=task.finally(():void=>{this.closing=null;});return this.closing;
  }
}

/** API24 ArkUI dialog bound to this host's real UIContext. Cancellation closes
 * this exact ComponentContent and waits onDidDisappear, never a global dialog. */
export class HarmonyArkUIDisclosureDriver implements HarmonyDisclosureDriver {
  private readonly ui: UIContext;
  constructor(ui: UIContext) {this.ui=ui;}
  create(model: HarmonyDisclosureModel, decision: (granted: boolean) => void, dismissed: () => void): HarmonyDisclosureHandle {
    return new ArkUIDisclosureHandle(this.ui,model,decision,dismissed);
  }
}
