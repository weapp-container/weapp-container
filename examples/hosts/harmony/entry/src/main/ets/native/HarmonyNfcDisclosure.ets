import { ComponentContent } from '@ohos.arkui.node';
import { UIContext } from '@ohos.arkui.UIContext';
import { BusinessError } from '@ohos.base';
import { HarmonyDisclosureDriver, HarmonyDisclosureHandle, HarmonyDisclosureModel } from '../session/DisclosurePrompts';

class NfcDisclosureContentModel {
  readonly identity: HarmonyDisclosureModel;
  readonly decide: (granted: boolean) => void;
  constructor(identity: HarmonyDisclosureModel, decide: (granted: boolean) => void) {this.identity=identity;this.decide=decide;}
}

@Builder
function NfcDisclosureContent(model: NfcDisclosureContentModel) {
  Column({space:16}) {
    Text('授权 NFC 标签读写').fontSize(20).fontWeight(FontWeight.Bold)
    Text(`${model.identity.appId}（${model.identity.publisherId}）`).fontSize(14)
    Text('允许此小程序读取附近 NFC 标签并向你选择的标签写入数据？请确认用途后，再将标签靠近设备。').fontSize(16)
    Text(`用途：${model.identity.purpose}`).fontSize(16)
    Row({space:20}) {
      Button('拒绝').onClick(():void=>model.decide(false))
      Button('允许').onClick(():void=>model.decide(true))
    }
  }.padding(24).width('88%').backgroundColor(Color.White).borderRadius(16)
}

class ArkUINfcDisclosureHandle implements HarmonyDisclosureHandle {
  private readonly ui: UIContext;
  private readonly content: ComponentContent<NfcDisclosureContentModel>;
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
    this.content=new ComponentContent(ui,wrapBuilder(NfcDisclosureContent),new NfcDisclosureContentModel(model,decision));
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
export class HarmonyNfcDisclosureDriver implements HarmonyDisclosureDriver {
  private readonly ui: UIContext;
  constructor(ui: UIContext) {this.ui=ui;}
  create(model: HarmonyDisclosureModel, decision: (granted: boolean) => void, dismissed: () => void): HarmonyDisclosureHandle {
    return new ArkUINfcDisclosureHandle(this.ui,model,decision,dismissed);
  }
}
