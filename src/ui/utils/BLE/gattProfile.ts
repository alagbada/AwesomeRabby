/**
 * PrismTx BLE GATT Profile
 *
 * Defines the Bluetooth service and characteristic UUIDs used between
 * the PrismTx browser extension (Central / GATT Client) and the
 * PrismTx Key mobile app (Peripheral / GATT Server).
 *
 * Service layout:
 *
 *   PrismTx Service (PRISMTX_SERVICE_UUID)
 *   │
 *   ├── COMM_WRITE   [WRITE]   Extension → Phone
 *   │     All outgoing data: TSS round messages, signing requests
 *   │
 *   ├── COMM_NOTIFY  [NOTIFY]  Phone → Extension
 *   │     All incoming data: TSS round responses, partial signatures
 *   │
 *   └── STATUS       [NOTIFY]  Phone → Extension
 *         Phone state updates: ready, approved, rejected, busy
 *
 * Chunking protocol (prepended to every BLE write):
 *   Byte 0: total number of chunks (1-based)
 *   Byte 1: this chunk's index (0-based)
 *   Bytes 2+: payload fragment
 *
 * All payloads are AES-256-GCM encrypted before chunking:
 *   Bytes 0–11:  IV (12 bytes, random per message)
 *   Bytes 12+:   ciphertext + 16-byte auth tag (appended by AES-GCM)
 */

// ─── GATT UUIDs ──────────────────────────────────────────────────────────────

export const PRISMTX_SERVICE_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
export const COMM_WRITE_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d480';
export const COMM_NOTIFY_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d481';
export const STATUS_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d482';

// ─── Chunking ────────────────────────────────────────────────────────────────

/**
 * Conservative chunk size that fits within the default BLE ATT MTU on all
 * major platforms (Windows, macOS, iOS, Android).
 * 2 bytes header + 178 bytes payload = 180 bytes per BLE packet.
 */
export const CHUNK_SIZE = 180;
export const CHUNK_HEADER_BYTES = 2;
export const CHUNK_PAYLOAD_SIZE = CHUNK_SIZE - CHUNK_HEADER_BYTES; // 178 bytes

// ─── Message types ───────────────────────────────────────────────────────────

/**
 * Identifies the purpose of a BLE message payload.
 * Both sides must agree on these values — the mobile app mirrors them.
 */
export enum BLEMessageType {
  // Key generation (DKG) rounds — P1 → P2
  KEYGEN_R1 = 'keygen_r1',
  KEYGEN_R3 = 'keygen_r3',

  // Key generation (DKG) rounds — P2 → P1
  KEYGEN_R2 = 'keygen_r2',
  KEYGEN_DONE = 'keygen_done',

  // Signing rounds — P1 → P2
  SIGN_INIT = 'sign_init',
  SIGN_R1 = 'sign_r1',
  SIGN_R3 = 'sign_r3',

  // Signing rounds — P2 → P1
  SIGN_R2 = 'sign_r2',
  SIGN_R4 = 'sign_r4',
}

/**
 * Status values sent by the phone on the STATUS characteristic.
 * These are plain UTF-8 strings (not JSON) for minimal overhead.
 */
export enum PhoneStatus {
  READY = 'ready', // App is open and waiting for a request
  APPROVED = 'approved', // User tapped Approve + passed biometric
  REJECTED = 'rejected', // User tapped Reject
  BUSY = 'busy', // Another signing session is already active
  ERROR = 'error', // Something went wrong on the phone
}

// ─── Payload shape ───────────────────────────────────────────────────────────

/**
 * The JSON object that gets serialised, encrypted, chunked, and written to
 * COMM_WRITE (extension → phone) or COMM_NOTIFY (phone → extension).
 */
export interface BLEPayload {
  /** Identifies the TSS round this message belongs to */
  type: BLEMessageType;
  /**
   * Unique ID for this signing / keygen session.
   * Lets the phone validate that messages belong to the current request
   * and reject stale or replayed packets.
   */
  sessionId: string;
  /** Message-specific data. TSS rounds use base64-encoded raw bytes. */
  data: string;
}

export interface SignInitPayload {
  /** 32-byte hash the phone will ask the user to approve */
  msgHashHex: string;
  /** Human-readable context displayed on the phone */
  description: string;
  /** Approval category, e.g. SignTx, SignText, SignTypedData */
  approvalType: string;
}

// ─── BLE connection status (for UI feedback) ─────────────────────────────────

export enum BLEStatus {
  IDLE = 'idle', // Not started
  SCANNING = 'scanning', // watchAdvertisements() running, phone not yet seen
  CONNECTING = 'connecting', // gatt.connect() in progress
  CONNECTED = 'connected', // GATT connection established, ready to communicate
  DISCONNECTED = 'disconnected', // Connection was lost or cleanly closed
  TIMEOUT = 'timeout', // Phone did not open app within the allowed window
  ERROR = 'error', // Unrecoverable BLE error
}
