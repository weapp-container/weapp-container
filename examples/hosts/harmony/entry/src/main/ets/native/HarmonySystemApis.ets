import common from '@ohos.app.ability.common';
import contact from '@ohos.contact';
import calendarManager from '@ohos.calendarManager';
import image from '@ohos.multimedia.image';
import { BusinessError } from '@ohos.base';
import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';
import { HarmonyManagedFiles } from './HarmonyManagedFiles';

interface ContactInput {
  firstName?: string; lastName?: string; middleName?: string; nickName?: string;
  mobilePhoneNumber?: string; homePhoneNumber?: string; workPhoneNumber?: string;
  hostNumber?: string; homeFaxNumber?: string; workFaxNumber?: string;
  email?: string; organization?: string; title?: string; url?: string; remark?: string;
  weChatNumber?: string; photoFilePath?: string;
  addressCity?: string; addressCountry?: string; addressPostalCode?: string; addressState?: string; addressStreet?: string;
  homeAddressCity?: string; homeAddressCountry?: string; homeAddressPostalCode?: string; homeAddressState?: string; homeAddressStreet?: string;
  workAddressCity?: string; workAddressCountry?: string; workAddressPostalCode?: string; workAddressState?: string; workAddressStreet?: string;
}
interface CalendarInput {
  title?: string; startTime?: number; endTime?: string | number; description?: string; location?: string;
  alarm?: boolean; alarmOffset?: number; allDay?: boolean; repeatInterval?: string; repeatEndTime?: number;
  path?: string; signature?: string;
}
interface SelectionResult { errMsg: string; displayName: string; phoneNumber: string; phoneNumberList: Array<string>; }
interface SystemResult { errMsg: string; }
interface ImageLease { source: image.ImageSource; pixels?: image.PixelMap; releasing?: Promise<void>; }

/** System-owned confirmation UI. No address-book/calendar permission or host
 * credentials are silently granted to a guest. The official UI promises have
 * no dismissal handle: retirement waits for their real completion, then drops
 * the result. It never treats cancellation as undoing a user's saved entry.
 */
export class HarmonySystemApis {
  readonly supportedApis: Array<string> = [
    'wx.chooseContact', 'wx.addPhoneContact', 'wx.addPhoneCalendar', 'wx.addPhoneRepeatCalendar',
  ];
  private readonly context: common.UIAbilityContext;
  private readonly files: HarmonyManagedFiles;
  private foreground: boolean = true;
  private closed: boolean = false;
  private generation: number = 0;
  private busy: boolean = false;
  private editorOpen: boolean = false;
  private readonly images: Set<ImageLease> = new Set();

  constructor(context: common.UIAbilityContext, services: HarmonyHostServices, files: HarmonyManagedFiles) {
    this.context = context; this.files = files;
    for (const api of this.supportedApis) services.registerApiHandler(api, async (payload: Object, call: HarmonyApiCall): Promise<Object> => {
      const generation = this.generation;
      this.requireCurrent(call, generation, true);
      if (this.busy || this.images.size>0) throw new HarmonyApiError('invalid_request', 'another system editor or image cleanup is active');
      if (JSON.stringify(payload).length > 16384) throw new HarmonyApiError('invalid_request', 'system editor payload exceeds limit');
      this.busy = true;
      try {
        if (api === 'wx.chooseContact') return await this.choose(call, generation);
        if (api === 'wx.addPhoneContact') await this.addContact(payload as ContactInput, call, generation);
        else await this.addCalendar(api, payload as CalendarInput, call, generation);
        this.requireCurrent(call, generation);
        const result: SystemResult = { errMsg: `${api.slice(3)}:ok` }; return result;
      } catch (error) {
        if (error instanceof HarmonyApiError) throw error;
        const native = error as BusinessError;
        throw new HarmonyApiError(native.code === 201 ? 'permission_denied' : native.code === 801 ? 'unsupported' : native.code === 16700103 ? 'cancelled' : 'invalid_request',
          native.message, native.code, `${api.slice(3)}:fail ${native.message}`);
      } finally { this.editorOpen = false; this.busy = false; }
    });
    // A system picker can itself background the UIAbility. Its explicit user
    // interaction remains in flight, while new guest calls stay blocked.
    services.onForeground((visible: boolean) => { this.foreground = visible; if (!visible && !this.editorOpen) this.generation++; });
    services.onClose(() => this.close());
  }
  private requireCurrent(call: HarmonyApiCall, generation: number, foreground: boolean = false): void {
    if (this.closed || call.cancellation.cancelled || generation !== this.generation) throw new HarmonyApiError('cancelled', 'system editor owner retired');
    if (foreground && !this.foreground) throw new HarmonyApiError('permission_denied', 'foreground system editor required');
  }
  private text(value?: string): string {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\u0000')) throw new HarmonyApiError('invalid_request', 'invalid system editor text');
    return value;
  }
  private async choose(call: HarmonyApiCall, generation: number): Promise<SelectionResult> {
    this.editorOpen = true;
    const selected = await contact.selectContacts({ isMultiSelect: false });
    this.requireCurrent(call, generation);
    if (selected.length === 0) throw new HarmonyApiError('cancelled', 'contact selection cancelled');
    if (selected.length !== 1) throw new HarmonyApiError('invalid_request', 'single contact selection required');
    const value = selected[0], numbers = value.phoneNumbers || [];
    if (numbers.length > 64) throw new HarmonyApiError('invalid_request', 'selected contact has too many phone numbers');
    const phones: Array<string> = [];
    for (const number of numbers) { const phone = this.text(number.phoneNumber); if (phone.length > 0 && !phones.includes(phone)) phones.push(phone); }
    if (phones.length === 0) throw new HarmonyApiError('invalid_request', 'selected contact has no phone number');
    return { errMsg: 'chooseContact:ok', displayName: this.text(value.name?.fullName), phoneNumber: phones[0], phoneNumberList: phones };
  }
  private address(city?: string, country?: string, postalCode?: string, state?: string, street?: string, label?: string): contact.PostalAddress | null {
    const values = [this.text(street), this.text(city), this.text(state), this.text(postalCode), this.text(country)];
    if (values.every((value: string) => value.length === 0)) return null;
    const value: contact.PostalAddress = { postalAddress: values.filter((part: string) => part.length > 0).join(', '), street: values[0], city: values[1], region: values[2], postcode: values[3], country: values[4], labelName: label };
    return value;
  }
  private async addContact(options: ContactInput, call: HarmonyApiCall, generation: number): Promise<void> {
    const first = this.text(options.firstName);
    if (!first.trim()) throw new HarmonyApiError('invalid_request', 'firstName required');
    const last = this.text(options.lastName), middle = this.text(options.middleName);
    const value: contact.Contact = { name: { fullName: [first, middle, last].filter((part: string) => part.length > 0).join(' '), givenName: first, familyName: last, middleName: middle } };
    const phones: Array<contact.PhoneNumber> = [];
    const addPhone = (phone: string | undefined, label: string): void => { const text = this.text(phone); if (text.length > 0) phones.push({ phoneNumber: text, labelName: label }); };
    addPhone(options.mobilePhoneNumber, 'mobile'); addPhone(options.homePhoneNumber, 'home'); addPhone(options.workPhoneNumber, 'work');
    addPhone(options.hostNumber, 'company'); addPhone(options.homeFaxNumber, 'home fax'); addPhone(options.workFaxNumber, 'work fax'); value.phoneNumbers = phones;
    if (options.nickName !== undefined) value.nickName = { nickName: this.text(options.nickName) };
    if (options.email !== undefined) value.emails = [{ email: this.text(options.email) }];
    if (options.organization !== undefined || options.title !== undefined) value.organization = { name: this.text(options.organization), title: this.text(options.title) };
    if (options.url !== undefined) value.websites = [{ website: this.text(options.url) }];
    if (options.remark !== undefined) value.note = { noteContent: this.text(options.remark) };
    if (options.weChatNumber !== undefined) value.imAddresses = [{ imAddress: this.text(options.weChatNumber), labelName: 'WeChat' }];
    const addresses: Array<contact.PostalAddress> = [];
    for (const address of [this.address(options.addressCity, options.addressCountry, options.addressPostalCode, options.addressState, options.addressStreet, 'other'),
      this.address(options.homeAddressCity, options.homeAddressCountry, options.homeAddressPostalCode, options.homeAddressState, options.homeAddressStreet, 'home'),
      this.address(options.workAddressCity, options.workAddressCountry, options.workAddressPostalCode, options.workAddressState, options.workAddressStreet, 'work')]) if (address !== null) addresses.push(address);
    value.postalAddresses = addresses;
    let lease: ImageLease | null = null;
    let operationFinished: () => void = () => {};
    // This barrier represents the actual picker/decoder acquisition terminal.
    // Resource release is a separate retryable action on the retained lease;
    // caching a rejected release Promise would make every future retry fail
    // after the real decoder had already been successfully released.
    const operation = new Promise<void>((resolve) => { operationFinished=resolve; });
    call.cancellation.onCancel(async():Promise<void>=>{await operation;if(lease!==null)await this.releaseImage(lease);});
    try {
      if (options.photoFilePath !== undefined) {
        const bytes = this.files.readUpload(this.text(options.photoFilePath), call);
        if (bytes.byteLength === 0 || bytes.byteLength > 1048576) throw new HarmonyApiError('invalid_request', 'contact photo must be 1..1048576 encoded bytes');
        lease = { source: image.createImageSource(bytes.buffer) }; this.images.add(lease);
        const info = await lease.source.getImageInfo(); this.requireCurrent(call, generation);
        if (info.size.width < 1 || info.size.height < 1 || info.size.width * info.size.height > 16777216) throw new HarmonyApiError('invalid_request', 'contact photo dimensions exceed decoder limit');
        const ratio = Math.min(1, 512 / Math.max(info.size.width, info.size.height));
        lease.pixels = await lease.source.createPixelMap({ desiredSize: { width: Math.max(1, Math.round(info.size.width * ratio)), height: Math.max(1, Math.round(info.size.height * ratio)) } });
        this.requireCurrent(call, generation); value.portrait = { uri: '', photo: lease.pixels };
      }
      this.requireCurrent(call, generation, true); this.editorOpen = true;
      const id = await contact.addContactViaUI(this.context, value);
      this.requireCurrent(call, generation);
      if (id < 0) throw new HarmonyApiError('cancelled', 'contact was not saved');
    } finally {
      try { if (lease !== null) await this.releaseImage(lease); }
      finally { operationFinished(); }
    }
  }
  private seconds(value: number | string | undefined, name: string): number {
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !/^[0-9]+(?:\.[0-9]{1,3})?$/.test(value))) throw new HarmonyApiError('invalid_request', `${name} must be a Unix timestamp in seconds`);
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 253402300799 || !Number.isSafeInteger(seconds * 1000)) throw new HarmonyApiError('invalid_request', `${name} is outside calendar range`);
    return seconds * 1000;
  }
  private async addCalendar(api: string, options: CalendarInput, call: HarmonyApiCall, generation: number): Promise<void> {
    const title = this.text(options.title);
    if (!title.trim()) throw new HarmonyApiError('invalid_request', 'calendar title required');
    if (options.path !== undefined || options.signature !== undefined) throw new HarmonyApiError('unsupported', 'WeChat session_key calendar links require a separately configured host link signer');
    if ((options.alarm !== undefined && typeof options.alarm !== 'boolean') || (options.allDay !== undefined && typeof options.allDay !== 'boolean')) throw new HarmonyApiError('invalid_request', 'alarm/allDay must be boolean');
    const start = this.seconds(options.startTime, 'startTime'), end = options.endTime === undefined ? start : this.seconds(options.endTime, 'endTime');
    if (end < start) throw new HarmonyApiError('invalid_request', 'endTime precedes startTime');
    const value: calendarManager.Event = { type: calendarManager.EventType.NORMAL, title, startTime: start, endTime: end,
      isAllDay: options.allDay === true, description: this.text(options.description), location: { location: this.text(options.location) } };
    if (options.alarm !== false) {
      const offset = options.alarmOffset === undefined ? 0 : options.alarmOffset;
      // OpenHarmony reminders are whole minutes. Refuse lossy conversion.
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 31536000) throw new HarmonyApiError('invalid_request', 'invalid alarmOffset');
      if (offset % 60 !== 0) throw new HarmonyApiError('unsupported', 'calendar reminders support whole minutes');
      value.reminderTime = [offset / 60];
    } else value.reminderTime = [];
    if (api === 'wx.addPhoneRepeatCalendar') {
      const interval = options.repeatInterval || 'month';
      if (!['day', 'week', 'month', 'year'].includes(interval)) throw new HarmonyApiError('invalid_request', 'unknown repeatInterval');
      if (interval === 'month' && new Date(start).getDate() > 28) throw new HarmonyApiError('invalid_request', 'monthly recurrence requires day 1..28');
      const frequency = interval === 'day' ? calendarManager.RecurrenceFrequency.DAILY : interval === 'week' ? calendarManager.RecurrenceFrequency.WEEKLY : interval === 'month' ? calendarManager.RecurrenceFrequency.MONTHLY : calendarManager.RecurrenceFrequency.YEARLY;
      const rule: calendarManager.RecurrenceRule = { recurrenceFrequency: frequency, interval: 1 };
      if (options.repeatEndTime !== undefined) { rule.expire = this.seconds(options.repeatEndTime, 'repeatEndTime'); if (rule.expire < start) throw new HarmonyApiError('invalid_request', 'repeatEndTime precedes startTime'); }
      value.recurrenceRule = rule;
    }
    this.requireCurrent(call, generation, true); this.editorOpen = true;
    const id = await calendarManager.getCalendarManager(this.context).editEvent(value);
    this.requireCurrent(call, generation);
    if (id < 0) throw new HarmonyApiError('cancelled', 'calendar event was not saved');
  }
  private releaseImage(lease: ImageLease): Promise<void> {
    if(!this.images.has(lease))return Promise.resolve();
    if(lease.releasing!==undefined)return lease.releasing;
    const task=(async():Promise<void>=>{
      if (lease.pixels !== undefined) { await lease.pixels.release(); lease.pixels = undefined; }
      await lease.source.release(); this.images.delete(lease);
    })();lease.releasing=task.finally(():void=>{lease.releasing=undefined;});return lease.releasing;
  }
  async close(): Promise<void> {
    this.closed = true; this.foreground = false; this.generation++;
    const failures: Array<Error> = [];
    // A running editor owns its image until its awaited native UI completes;
    // HostServices tracks that execution as part of its retirement barrier.
    if (!this.busy) for (const lease of this.images) { try { await this.releaseImage(lease); } catch (error) { failures.push(error as Error); } }
    if (failures.length > 0) throw new Error(`${failures.length} contact images failed to release`);
  }
}
