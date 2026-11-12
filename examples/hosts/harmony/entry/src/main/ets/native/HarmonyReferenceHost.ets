import { UIContext } from '@ohos.arkui.UIContext';
import { HarmonyHostServices, HarmonyHostServicesConfig, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';
import { HarmonyAccountOwnerContext, harmonyStorageScope } from '../session/HostAccountManager';
import { HarmonyReferenceIdentity, HarmonyReferencePayments, HarmonyNativePaymentChannel } from '../session/ReferenceHostServices';
import { HarmonyDisclosurePrompts } from '../session/DisclosurePrompts';
import { HarmonyAccountHttpsTransport } from './HarmonyAccountTransport';
import { HarmonyArkUIDisclosureDriver } from './HarmonyDisclosurePrompts';

export interface HarmonyReferenceHostOptions {
  origin: string;
  hostToken: (call: HarmonyApiCall) => string | Promise<string>;
  timeoutMs?: number;
  paymentChannels?: Array<HarmonyNativePaymentChannel>;
  onError?: (error: Object) => void;
}
export interface HarmonyReferenceHostInstallation {
  identity: HarmonyReferenceIdentity;
  payments: HarmonyReferencePayments;
}
let configured: HarmonyReferenceHostOptions | null = null;

/** Host-only configuration; never a guest API. Null is the shipped default.
 * Updated configuration applies only to fresh account execution owners. */
export function configureHarmonyReferenceHost(options: HarmonyReferenceHostOptions | null): void {
  if(options===null){configured=null;return;}
  if(typeof options.origin!=='string'||typeof options.hostToken!=='function')throw new HarmonyApiError('invalid_request','native account backend origin and hostToken are required');
  configured={origin:options.origin,hostToken:options.hostToken,timeoutMs:options.timeoutMs,paymentChannels:options.paymentChannels===undefined?[]:options.paymentChannels.slice(),onError:options.onError};
}
function report(options: HarmonyReferenceHostOptions,error: Object): void {
  try{if(options.onError!==undefined)options.onError(error);else console.error(`WEAPP_CONTAINER_ACCOUNT_ERROR ${String(error)}`);}
  catch(observerError){console.error(`WEAPP_CONTAINER_ACCOUNT_OBSERVER_ERROR ${String(observerError)}`);}
}

/** Replayed by the owner factory before native configure/app.init. The identity
 * snapshot is fetched before synchronous JS reads are advertised. */
export async function installHarmonyReferenceHost(services: HarmonyHostServices,configuration: HarmonyHostServicesConfig,uiContext: UIContext,ownerContext: HarmonyAccountOwnerContext): Promise<HarmonyReferenceHostInstallation | null> {
  const options=configured;if(options===null)return null;
  if(harmonyStorageScope(configuration.application,configuration.account)!==ownerContext.storageScope||configuration.application.version!==ownerContext.application.version||configuration.application.packRoot!==ownerContext.application.packRoot||configuration.account.epoch!==ownerContext.account.epoch)throw new HarmonyApiError('invalid_request','reference backend must bind the exact account owner identity');
  // Preflight performs native network work before LiveSession.start(). Its
  // cancellation must therefore revoke services even before a candidate owner
  // has returned to the manager, and retain the real HTTP/UI cleanup barriers.
  const remove=ownerContext.cancellation.onCancel(():void=>services.revoke());
  services.onClose(():void=>remove());
  const transport=new HarmonyAccountHttpsTransport({origin:options.origin,hostToken:options.hostToken,timeoutMs:options.timeoutMs});
  services.onClose(():Promise<void>=>transport.close());
  const prompts=new HarmonyDisclosurePrompts(services,new HarmonyArkUIDisclosureDriver(uiContext));
  const identity=new HarmonyReferenceIdentity(services,transport,{
    confirm:(policy,call):Promise<boolean>=>prompts.confirm(policy,call),
    logoutApplication:():void=>{
      // Starting replacement is synchronous. Waiting for its retirement from
      // the current old-owner handler would deadlock that handler's own drain.
      ownerContext.requestLogout().catch((error:Object):void=>report(options,error));
    },
  });
  const payments=new HarmonyReferencePayments(services,transport,options.paymentChannels||[]);
  await identity.prepare(configuration);
  if(ownerContext.cancellation.cancelled)throw new HarmonyApiError('cancelled','reference backend preparation owner retired');
  return {identity,payments};
}
