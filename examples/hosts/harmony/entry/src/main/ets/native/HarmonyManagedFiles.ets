import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';

interface FileOptions { objectId?: string; filePath?: string; tempFilePath?: string; data?: Object; encoding?: string; }
interface FileResult { objectId?: string; errMsg?: string; }
interface BinaryValue { __weappBinary: BinaryBytes; }
interface BinaryBytes { type: string; bytes: Array<number>; }

/** The Rust owner vends the app/account-scoped directory and executes bounded
 * file operations. ArkTS never joins guest paths onto a filesystem directory.
 */
export class HarmonyManagedFiles {
  private readonly services: HarmonyHostServices;
  private readonly objects: Set<string> = new Set();
  private temporarySequence: number = 0;
  readonly supportedApis: Array<string> = [
    'wx.getFileSystemManager',
    'object:FileSystemManager.access','object:FileSystemManager.appendFile','object:FileSystemManager.copyFile',
    'object:FileSystemManager.mkdir','object:FileSystemManager.stat','object:FileSystemManager.readFile','object:FileSystemManager.readdir',
    'object:FileSystemManager.rename','object:FileSystemManager.rmdir','object:FileSystemManager.unlink','object:FileSystemManager.writeFile',
    'object:FileSystemManager.saveFile','object:FileSystemManager.removeSavedFile','object:FileSystemManager.getSavedFileList',
  ];
  readonly syncApis: Array<string> = [
    'object:FileSystemManager.accessSync','object:FileSystemManager.appendFileSync','object:FileSystemManager.copyFileSync',
    'object:FileSystemManager.mkdirSync','object:FileSystemManager.readFileSync','object:FileSystemManager.readdirSync',
    'object:FileSystemManager.renameSync','object:FileSystemManager.rmdirSync','object:FileSystemManager.statSync',
    'object:FileSystemManager.unlinkSync','object:FileSystemManager.writeFileSync',
  ];
  constructor(services: HarmonyHostServices, hostPrivateRoot: string) {
    this.services=services;services.setManagedFilesRoot(hostPrivateRoot);
    for(const name of this.syncApis)services.declareNativeApi(name);
    for(const name of this.supportedApis)services.registerApiHandler(name,async(payload:Object,call:HarmonyApiCall):Promise<Object>=>{
      if(call.cancellation.cancelled)throw new HarmonyApiError('cancelled','file owner retired');
      const options=payload as FileOptions;
      if(name==='wx.getFileSystemManager') {
        if(typeof options.objectId!=='string'||this.objects.size>=256)throw new HarmonyApiError('invalid_request','file manager object identity required');
        this.services.managedFileScope(call.context);const objectId=options.objectId;this.objects.add(objectId);
        call.cancellation.retainUntilCancelled();call.cancellation.onCancel(()=>{this.objects.delete(objectId);});
        const result:FileResult={objectId};return result;
      }
      if(typeof options.objectId!=='string'||!this.objects.has(options.objectId))throw new HarmonyApiError('cancelled','file manager belongs to a retired owner');
      return this.services.managedFile(call.context,name,payload);
    });
    services.onClose(()=>{this.objects.clear();});
  }
  writeTemporary(bytes: Uint8Array, call: HarmonyApiCall, requestedPath?: string): string {
    const path=requestedPath||`wxfile://user/download-${Date.now()}-${++this.temporarySequence}`;
    if(bytes.byteLength>8*1048576)throw new HarmonyApiError('invalid_request','download exceeds eight MiB');
    for(let offset=0;offset<bytes.byteLength||offset===0;offset+=1048576) {
      if(call.cancellation.cancelled)throw new HarmonyApiError('cancelled','download owner retired');
      const chunk=bytes.slice(offset,Math.min(bytes.byteLength,offset+1048576));
      const values:Array<number>=[];for(const value of chunk)values.push(value);
      const data:BinaryValue={__weappBinary:{type:'ArrayBuffer',bytes:values}};
      const payload:FileOptions={filePath:path,data};
      this.services.managedFile(call.context,`object:FileSystemManager.${offset===0?'writeFile':'appendFile'}`,payload);
    }
    return path;
  }
  readUpload(path: string, call: HarmonyApiCall): Uint8Array {
    const result=this.services.managedFile(call.context,'object:FileSystemManager.readFile',{filePath:path}) as Record<string,Object>;
    const binary=result['data'] as BinaryValue;
    if(binary===undefined||binary.__weappBinary===undefined)throw new HarmonyApiError('invalid_request','upload file did not yield bounded binary data');
    return new Uint8Array(binary.__weappBinary.bytes);
  }
}
