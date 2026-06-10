/**
 * PrismTx BLE Service
 *
 * Manages the Bluetooth connection between the extension approval popup
 * (Central / GATT Client) and the PrismTx Key mobile app
 * (Peripheral / GATT Server).
 *
 * Responsibilities:
 *   - Wait for the phone to open the app (watchAdvertisements)
 *   - Connect to the paired device without showing the picker
 *   - Encrypt outgoing messages with AES-256-GCM
 *   - Decrypt and verify incoming messages
 *   - Chunk large payloads into BLE-sized packets
 *   - Reassemble incoming chunks into complete messages
 *   - Surface phone status updates (approved / rejected / etc.)
 *
 * Usage:
 *   const ble = new BLEService(pairedDeviceId, sessionKeyB64);
 *   await ble.waitAndConnect(onStatusChange);  // blocks until phone opens app
 *   await ble.send({ type, sessionId, data }); // send a TSS round message
 *   const reply = await ble.receive();         // wait for phone's response
 *   ble.disconnect();
 */

import {
  PRISMTX_SERVICE_UUID,
  COMM_WRITE_UUID,
  COMM_NOTIFY_UUID,
  STATUS_UUID,
  CHUNK_SIZE,
  CHUNK_HEADER_BYTES,
  CHUNK_PAYLOAD_SIZE,
  BLEPayload,
  BLEStatus,
  PhoneStatus,
} from './gattProfile';

// Re-export so consumers can import BLEStatus from this module
export { BLEStatus } from './gattProfile';

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusCallback = (status: BLEStatus) => void;
type PhoneCallback = (status: PhoneStatus) => void;

// ─── BLEService ───────────────────────────────────────────────────────────────

export class BLEService {
  private readonly deviceId: string;
  private readonly sessionKeyB64: string;

  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private statusChar: BluetoothRemoteGATTCharacteristic | null = null;

  // Incoming chunk reassembly buffer
  private incomingChunks: Uint8Array[] = [];
  private expectedChunkCount = 0;

  // Completed-message queue and waiters
  private messageQueue: BLEPayload[] = [];
  private messageWaiters: Array<(p: BLEPayload) => void> = [];

  // Phone status callback — fires on STATUS characteristic notifications
  private onPhoneStatus: PhoneCallback | null = null;

  // CryptoKey object (derived once from sessionKeyB64)
  private cryptoKey: CryptoKey | null = null;

  constructor(deviceId: string, sessionKeyB64: string) {
    this.deviceId = deviceId;
    this.sessionKeyB64 = sessionKeyB64;
  }

  get connected(): boolean {
    return this.server?.connected ?? false;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Wait for the phone to open PrismTx Key and start advertising, then
   * connect, discover characteristics, and subscribe to notifications.
   *
   * @param onStatus  Called with UI-facing BLEStatus updates
   * @param onPhone   Called whenever the phone sends a PhoneStatus update
   * @param timeoutMs How long to wait before giving up (default: 2 minutes)
   */
  async waitAndConnect(
    onStatus: StatusCallback,
    onPhone: PhoneCallback,
    timeoutMs = 120_000
  ): Promise<void> {
    this.onPhoneStatus = onPhone;
    this.cryptoKey = await this._importKey(this.sessionKeyB64);

    const device = await this._getPairedDevice();
    this.device = device;

    onStatus(BLEStatus.SCANNING);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        device.removeEventListener('advertisementreceived', onAd);
        device.onadvertisementreceived = undefined!;
        onStatus(BLEStatus.TIMEOUT);
        reject(new Error('PrismTx Key: phone did not open within timeout'));
      }, timeoutMs);

      const onAd = async () => {
        clearTimeout(timer);
        device.removeEventListener('advertisementreceived', onAd);

        try {
          onStatus(BLEStatus.CONNECTING);
          this.server = await device.gatt!.connect();
          await this._discoverCharacteristics();
          onStatus(BLEStatus.CONNECTED);
          resolve();
        } catch (err) {
          onStatus(BLEStatus.ERROR);
          reject(err);
        }
      };

      device.addEventListener('advertisementreceived', onAd);

      // If the phone is already advertising (app already open), this resolves
      // the promise immediately via the 'advertisementreceived' event.
      device.watchAdvertisements().catch((err) => {
        clearTimeout(timer);
        device.removeEventListener('advertisementreceived', onAd);
        onStatus(BLEStatus.ERROR);
        reject(err);
      });
    });
  }

  /**
   * Encrypt a BLEPayload and write it to the phone via COMM_WRITE.
   */
  async send(payload: BLEPayload): Promise<void> {
    if (!this.writeChar) throw new Error('BLEService: not connected');

    const json = JSON.stringify(payload);
    const plaintext = new TextEncoder().encode(json);
    const encrypted = await this._encrypt(plaintext);
    const chunks = this._chunk(encrypted);

    console.log(
      `[BLE P1] send  type=${payload.type} chunks=${chunks.length} encBytes=${encrypted.byteLength}`
    );
    for (const chunk of chunks) {
      await this.writeChar.writeValueWithResponse(chunk);
    }
    console.log(
      `[BLE P1] send  type=${payload.type} — all ${chunks.length} chunk(s) written`
    );
  }

  /**
   * Wait for the next complete decrypted message from COMM_NOTIFY.
   * Resolves when a full message has been reassembled and decrypted.
   */
  receive(timeoutMs = 30_000): Promise<BLEPayload> {
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }

    return new Promise<BLEPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageWaiters = this.messageWaiters.filter((w) => w !== waiter);
        reject(
          new Error('BLEService: receive timeout waiting for phone response')
        );
      }, timeoutMs);

      const waiter = (payload: BLEPayload) => {
        clearTimeout(timer);
        resolve(payload);
      };

      this.messageWaiters.push(waiter);
    });
  }

  /**
   * Clean disconnect — stops notifications and drops the GATT connection.
   */
  disconnect(): void {
    try {
      this.notifyChar?.removeEventListener(
        'characteristicvaluechanged',
        this._onNotify
      );
      this.statusChar?.removeEventListener(
        'characteristicvaluechanged',
        this._onStatus
      );
      this.server?.disconnect();
    } catch {
      // best-effort cleanup
    } finally {
      this.server = null;
      this.writeChar = null;
      this.notifyChar = null;
      this.statusChar = null;
    }
  }

  // ─── Private: connection setup ───────────────────────────────────────────────

  private async _getPairedDevice(): Promise<BluetoothDevice> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this context');
    }

    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find((d) => d.id === this.deviceId);

    if (!device) {
      throw new Error(
        `BLEService: paired device ${this.deviceId} not found. ` +
          'The user may need to re-pair via Settings → PrismTx Key.'
      );
    }

    return device;
  }

  private async _discoverCharacteristics(): Promise<void> {
    const service = await this.server!.getPrimaryService(PRISMTX_SERVICE_UUID);

    this.writeChar = await service.getCharacteristic(COMM_WRITE_UUID);
    this.notifyChar = await service.getCharacteristic(COMM_NOTIFY_UUID);
    this.statusChar = await service.getCharacteristic(STATUS_UUID);

    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener(
      'characteristicvaluechanged',
      this._onNotify
    );

    await this.statusChar.startNotifications();
    this.statusChar.addEventListener(
      'characteristicvaluechanged',
      this._onStatus
    );
  }

  // ─── Private: GATT event handlers ────────────────────────────────────────────

  /**
   * Fires on every COMM_NOTIFY notification from the phone.
   * Reassembles chunks; decrypts and dispatches complete messages.
   */
  private _onNotify = async (event: Event): Promise<void> => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;

    const packet = new Uint8Array(value.buffer);
    if (packet.length < CHUNK_HEADER_BYTES) return;

    const totalChunks = packet[0];
    const chunkIndex = packet[1];
    const fragment = packet.slice(CHUNK_HEADER_BYTES);

    // First chunk of a new message — reset buffer
    if (chunkIndex === 0) {
      this.incomingChunks = new Array(totalChunks);
      this.expectedChunkCount = totalChunks;
    }

    this.incomingChunks[chunkIndex] = fragment;

    const received = this.incomingChunks.filter(Boolean).length;
    if (received < this.expectedChunkCount) return; // still waiting for more chunks

    // All chunks received — reassemble
    const encrypted = this._concat(this.incomingChunks as Uint8Array[]);
    this.incomingChunks = [];
    this.expectedChunkCount = 0;

    console.log(
      `[BLE P1] recv  reassembled ${encrypted.byteLength} encrypted bytes`
    );
    try {
      const plaintext = await this._decrypt(encrypted);
      const json = new TextDecoder().decode(plaintext);
      const payload = JSON.parse(json) as BLEPayload;
      console.log(
        `[BLE P1] recv  type=${
          payload.type
        } sessionId=${payload.sessionId?.slice(0, 8)}`
      );
      this._dispatchMessage(payload);
    } catch (err) {
      console.error('[BLE P1] recv  decrypt/parse FAILED:', err);
    }
  };

  /**
   * Fires on every STATUS notification from the phone.
   * Decodes the plain UTF-8 status string and forwards to the callback.
   */
  private _onStatus = (event: Event): void => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value || !this.onPhoneStatus) return;

    const status = new TextDecoder().decode(value.buffer) as PhoneStatus;
    this.onPhoneStatus(status);
  };

  private _dispatchMessage(payload: BLEPayload): void {
    if (this.messageWaiters.length > 0) {
      this.messageWaiters.shift()!(payload);
    } else {
      this.messageQueue.push(payload);
    }
  }

  // ─── Private: chunking ───────────────────────────────────────────────────────

  private _chunk(data: Uint8Array): Uint8Array[] {
    const totalChunks = Math.ceil(data.byteLength / CHUNK_PAYLOAD_SIZE);
    const chunks: Uint8Array[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_PAYLOAD_SIZE;
      const fragment = data.slice(start, start + CHUNK_PAYLOAD_SIZE);
      const packet = new Uint8Array(CHUNK_HEADER_BYTES + fragment.byteLength);
      packet[0] = totalChunks;
      packet[1] = i;
      packet.set(fragment, CHUNK_HEADER_BYTES);
      chunks.push(packet);
    }

    return chunks;
  }

  private _concat(arrays: Uint8Array[]): Uint8Array {
    const totalLen = arrays.reduce((n, a) => n + a.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.byteLength;
    }
    return result;
  }

  // ─── Private: AES-256-GCM encryption ────────────────────────────────────────

  private async _importKey(b64: string): Promise<CryptoKey> {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      false, // not extractable
      ['encrypt', 'decrypt']
    );
  }

  private async _encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.cryptoKey!,
      plaintext
    );
    // Layout: [ 12 bytes IV ][ ciphertext + 16-byte auth tag ]
    return this._concat([iv, new Uint8Array(ciphertext)]);
  }

  private async _decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (data.byteLength < 12 + 16) {
      throw new Error('BLEService: encrypted payload too short');
    }
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.cryptoKey!,
      ciphertext
    );
    return new Uint8Array(plaintext);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * First-time pairing: open the browser's BLE device picker filtered to
 * devices advertising the given serviceUUID, connect, and return a ready
 * BLEService along with the device's stable ID for future reconnections.
 *
 * Must be called from a user-gesture context (button click).
 * Only needed ONCE — subsequent connections use waitAndConnect() with
 * the stored deviceId.
 *
 * @param bleFilterUUID  Random UUID the phone starts advertising after
 *                       scanning the pairing QR code
 * @param sessionKeyB64  AES-256 key included in the QR payload
 * @param onStatus       UI status callback
 */
export async function pairNewDevice(
  bleFilterUUID: string,
  sessionKeyB64: string,
  onStatus: (s: BLEStatus) => void
): Promise<{ service: BLEService; deviceId: string }> {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth is not available in this context');
  }

  onStatus(BLEStatus.SCANNING);

  // Opens the browser's native BLE device picker, filtered to show only
  // devices advertising the bleFilterUUID (i.e. the user's phone with
  // PrismTx Key open after scanning the QR).
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [bleFilterUUID] }],
    optionalServices: [PRISMTX_SERVICE_UUID],
  });

  onStatus(BLEStatus.CONNECTING);

  const service = new BLEService(device.id, sessionKeyB64);

  // Bypass waitAndConnect (which uses watchAdvertisements for known devices)
  // and connect directly — the device is already in range and advertising.
  service['device'] = device;
  service['server'] = await device.gatt!.connect();
  service['cryptoKey'] = await service['_importKey'](sessionKeyB64);
  await service['_discoverCharacteristics']();

  onStatus(BLEStatus.CONNECTED);

  return { service, deviceId: device.id };
}

/**
 * Generate a new 256-bit AES session key and return it as a base64 string.
 * Used during the pairing ceremony to create the shared encryption key.
 */
export async function generateSessionKey(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — we need to export and share it
    ['encrypt', 'decrypt']
  );
  const raw = await crypto.subtle.exportKey('raw', key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

/**
 * Generate a cryptographically random UUID v4 for signing session IDs.
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}
