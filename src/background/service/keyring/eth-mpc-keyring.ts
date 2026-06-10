/**
 * PrismTx MPC Keyring
 *
 * Implements 2-of-2 threshold ECDSA using @safeheron/two-party-ecdsa-js.
 * Party 1 (P1) lives here in the extension.
 * Party 2 (P2) lives in the PrismTx Key mobile app.
 *
 * This keyring stores:
 *  - The wallet address (derived from the joint public key after DKG)
 *  - The P1 key share (encrypted in vault alongside other keyrings)
 *  - The paired BLE device ID (for reconnection without picker)
 *  - A session encryption key (AES-GCM, for encrypting BLE messages)
 *
 * NOTE: signTransaction / signPersonalMessage / signTypedData are intentionally
 * NOT implemented here. MPC signing requires live BLE interaction with the phone
 * and therefore must be orchestrated by the approval popup (which has access to
 * the Web Bluetooth API). The background calls getMPCSigningContext() to hand
 * the necessary data to the popup, which runs the TSS rounds and returns the
 * assembled signature.
 */

import { EventEmitter } from 'events';
import { addHexPrefix, toChecksumAddress } from '@ethereumjs/util';

export const keyringType = 'MPC Key';

// ─── Serialised shape stored in the encrypted vault ──────────────────────────

export interface MPCAccountData {
  /** Ethereum address (checksummed) */
  address: string;
  /** JSON-serialised KeyShare1 from @safeheron/two-party-ecdsa-js */
  keyShare1Json: string;
  /** Web Bluetooth device.id — used to reconnect without showing the picker */
  pairedDeviceId: string;
  /** Base64-encoded AES-GCM session key shared with the phone */
  sessionKeyB64: string;
  /** Hex-encoded joint public key (uncompressed, 65 bytes) */
  publicKeyHex: string;
}

export interface MPCKeyringData {
  accounts: MPCAccountData[];
}

// ─── Context returned to the popup for a live signing session ─────────────────

export interface MPCSigningContext {
  address: string;
  keyShare1Json: string;
  pairedDeviceId: string;
  sessionKeyB64: string;
}

// ─── Keyring class ────────────────────────────────────────────────────────────

class MPCKeyring extends EventEmitter {
  static type = keyringType;
  type = keyringType;

  private accounts: MPCAccountData[] = [];

  constructor(opts: MPCKeyringData = { accounts: [] }) {
    super();
    this.deserialize(opts);
  }

  // ─── Serialisation (persisted in the encrypted vault) ──────────────────────

  deserialize(opts: MPCKeyringData): void {
    this.accounts = opts.accounts ?? [];
  }

  serialize(): Promise<MPCKeyringData> {
    return Promise.resolve({ accounts: this.accounts });
  }

  // ─── Account management ────────────────────────────────────────────────────

  async getAccounts(): Promise<string[]> {
    return this.accounts.map((a) => a.address);
  }

  /**
   * Called after a successful DKG pairing to register the new MPC wallet.
   */
  addAccount(data: MPCAccountData): void {
    const checksummed = toChecksumAddress(addHexPrefix(data.address));

    if (
      this.accounts.find(
        (a) => a.address.toLowerCase() === checksummed.toLowerCase()
      )
    ) {
      throw new Error(`MPC account ${checksummed} already exists`);
    }

    this.accounts.push({ ...data, address: checksummed });
  }

  removeAccount(address: string): void {
    this.accounts = this.accounts.filter(
      (a) => a.address.toLowerCase() !== address.toLowerCase()
    );
  }

  // ─── Key share access (called by wallet controller → approval popup) ────────

  /**
   * Returns the data the approval popup needs to run TSS signing rounds over BLE.
   * The popup receives this, opens the BLE connection, runs the rounds, and
   * returns the assembled signature — it never comes back through here.
   */
  getMPCSigningContext(address: string): MPCSigningContext {
    const account = this._findAccount(address);
    return {
      address: account.address,
      keyShare1Json: account.keyShare1Json,
      pairedDeviceId: account.pairedDeviceId,
      sessionKeyB64: account.sessionKeyB64,
    };
  }

  /**
   * Returns a copy of the full account data for backup export.
   * The caller is responsible for encrypting the result before persisting.
   */
  exportAccountData(address: string): MPCAccountData {
    return { ...this._findAccount(address) };
  }

  /**
   * Restores an account from a previously exported (and decrypted) backup.
   * Throws if the address already exists in this keyring.
   */
  restoreAccountData(data: MPCAccountData): void {
    this.addAccount(data);
  }

  /**
   * Updates the stored key share after a key refresh operation.
   */
  updateKeyShare(address: string, newKeyShare1Json: string): void {
    const account = this._findAccount(address);
    account.keyShare1Json = newKeyShare1Json;
  }

  /**
   * Updates the paired device ID (e.g. after re-pairing with a new phone).
   */
  updatePairedDevice(
    address: string,
    newDeviceId: string,
    newSessionKeyB64: string
  ): void {
    const account = this._findAccount(address);
    account.pairedDeviceId = newDeviceId;
    account.sessionKeyB64 = newSessionKeyB64;
  }

  // ─── Signing — intentionally unsupported at the keyring level ──────────────
  //
  // MPC signing requires real-time BLE communication with the phone, which needs
  // the Web Bluetooth API. That API is only available in the extension popup
  // context, not in the background service worker where keyrings run.
  //
  // Flow:
  //   1. Approval popup detects KEYRING_CLASS.MPC account type
  //   2. Popup calls wallet.getMPCSigningContext(address)
  //   3. Popup runs TSS rounds over BLE (tssCoordinator.ts)
  //   4. Popup assembles the ECDSA signature
  //   5. Popup calls wallet.broadcastMPCSignedTransaction(signedTxHex)

  async signTransaction(): Promise<never> {
    throw new Error(
      'MPCKeyring: use the MPC signing flow in the approval popup — ' +
        'direct signTransaction is not supported.'
    );
  }

  async signPersonalMessage(): Promise<never> {
    throw new Error(
      'MPCKeyring: use the MPC signing flow in the approval popup — ' +
        'direct signPersonalMessage is not supported.'
    );
  }

  async signTypedData(): Promise<never> {
    throw new Error(
      'MPCKeyring: use the MPC signing flow in the approval popup — ' +
        'direct signTypedData is not supported.'
    );
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _findAccount(address: string): MPCAccountData {
    const account = this.accounts.find(
      (a) => a.address.toLowerCase() === address.toLowerCase()
    );
    if (!account) {
      throw new Error(`MPCKeyring: account ${address} not found`);
    }
    return account;
  }
}

export default MPCKeyring;
