/**
 * MPCWaiting — Approval waiting component for PrismTx MPC accounts.
 *
 * Replaces the normal "sign with keyring" flow for MPC accounts.
 * Instead of telling the background to sign (which would call
 * MPCKeyring.signTransaction and throw), this component:
 *
 *  1. Computes the transaction / message hash in the background worker
 *     via wallet.getMPCTxSignHash / getMPCPersonalMessageSignHash
 *  2. Waits for the user's phone to open PrismTx Key (BLE advertisement)
 *  3. Connects via BLE and runs the two-party Lindell17 signing protocol
 *  4. For transactions: assembles + broadcasts the signed tx, then resolves
 *     the approval with the tx hash (so the dApp gets the right response)
 *  5. For messages: resolves the approval with the 65-byte signature hex
 *
 * The background's requestDeferFn / waitSignComponentAmounted() is left
 * pending and simply abandoned — it causes no side-effect because
 * resolveApproval() has already closed the notification before any
 * background signing could run.
 */

import React, { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useApproval, useCommonPopupView, useWallet } from 'ui/utils';
import { Account } from 'background/service/preference';
import { BLEService } from '@/ui/utils/BLE/bleService';
import { BLEStatus } from '@/ui/utils/BLE/gattProfile';
import { runSignP1 } from '@/ui/utils/BLE/tssCoordinator';
import { generateSessionId } from '@/ui/utils/BLE/bleService';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApprovalParams {
  address: string;
  chainId?: number;
  from?: string;
  nonce?: string;
  isGnosis?: boolean;
  data?: string[];
  account?: Account;
  $account: Account;
  $ctx?: any;
  extra?: Record<string, any>;
  type: string;
  stay?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const MPCWaiting: React.FC<{
  params: ApprovalParams;
  account: Account;
}> = ({ params, account: $account }) => {
  const wallet = useWallet();
  const [getApproval, resolveApproval, rejectApproval] = useApproval();
  const { setTitle, setHeight, setVisible, closePopup } = useCommonPopupView();

  const [bleStatus, setBleStatus] = useState<BLEStatus>(BLEStatus.IDLE);
  const [statusText, setStatusText] = useState('Preparing…');
  const [errorMsg, setErrorMsg] = useState('');

  const { stay = false } = params;

  // ── Main flow — runs once on mount ────────────────────────────────────────
  useEffect(() => {
    setTitle('MPC Approval — PrismTx');
    setHeight('fit-content');
    setVisible(true);

    (async () => {
      try {
        // ── Step 1: Gather approval context ────────────────────────────────
        const approval = await getApproval();
        const account = params.isGnosis ? params.account! : $account;

        const approvalType = approval?.data.approvalType as string | undefined;

        // ── Step 2: Load MPC signing context from vault ────────────────────
        setStatusText('Loading key data…');
        const ctx = await wallet.getMPCSigningContext(account.address);
        const signingSessionId = generateSessionId();

        // ── Step 3: Compute the hash that must be signed ───────────────────
        let msgHashHex: string;
        let signingTxId: string | undefined;

        if (approvalType === 'SignTx') {
          // Transaction signing — hash the unsigned EIP-155 / EIP-1559 tx
          signingTxId = approval.data.params.signingTxId as string;
          if (!signingTxId) {
            throw new Error('MPC: signingTxId not found in approval params');
          }
          const { msgHashHex: h } = await wallet.getMPCTxSignHash(signingTxId);
          msgHashHex = h;
        } else if (approvalType === 'SignTypedData') {
          // EIP-712 typed-data signing
          const typedData = (params.extra?.mpcTypedData as string) ?? '';
          const version = (params.extra?.mpcSignVersion as string) ?? 'V4';
          if (!typedData) {
            throw new Error(
              'MPC: typed data missing from approval params. ' +
              'Ensure SignTypedData passes extra.mpcTypedData for MPC accounts.'
            );
          }
          msgHashHex = await wallet.getMPCTypedDataSignHash(typedData, version);
        } else {
          // Personal message signing — EIP-191 hash.
          // The raw message hex was forwarded from SignText.tsx via params.extra.mpcRawMessage.
          const rawMessage = (params.extra?.mpcRawMessage as string) ?? '';
          if (!rawMessage) {
            throw new Error(
              'MPC: raw message data missing from approval params. ' +
              'Ensure SignText passes extra.mpcRawMessage for MPC accounts.'
            );
          }
          msgHashHex = await wallet.getMPCPersonalMessageSignHash(rawMessage);
        }

        // ── Step 4: Connect to the paired phone via BLE ────────────────────
        setBleStatus(BLEStatus.SCANNING);
        setStatusText('Open PrismTx Key on your phone…');

        const ble = new BLEService(ctx.pairedDeviceId, ctx.sessionKeyB64);
        await ble.waitAndConnect(
          (s) => {
            setBleStatus(s);
            if (s === BLEStatus.CONNECTING) {
              setStatusText('Connecting to phone…');
            }
            if (s === BLEStatus.CONNECTED) {
              setStatusText('Running signing protocol…');
            }
          },
          () => {} // phone status updates — informational only
        );

        // ── Step 5: Run two-party signing over BLE ─────────────────────────
        setStatusText('Signing on both devices…');
        const sigResult = await runSignP1(
          ble,
          ctx.keyShare1Json,
          msgHashHex,
          signingSessionId
        );
        ble.disconnect();
        setBleStatus(BLEStatus.DISCONNECTED);

        // ── Step 6: Finalise and resolve ───────────────────────────────────
        if (signingTxId) {
          // Transaction: assemble + broadcast, resolve with txHash
          setStatusText('Broadcasting transaction…');
          const txHash = await wallet.completeMPCSigning(signingTxId, {
            r: sigResult.r,
            s: sigResult.s,
            v: sigResult.v,
          });
          closePopup();
          resolveApproval(txHash, stay, false, approval.id);
        } else {
          // Message: resolve with 65-byte signature hex
          closePopup();
          resolveApproval(sigResult.signatureHex, stay, false, approval.id);
        }
      } catch (err: any) {
        setBleStatus(BLEStatus.ERROR);
        setErrorMsg(err?.message || 'MPC signing failed unexpectedly.');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render: error state ───────────────────────────────────────────────────
  if (errorMsg) {
    return (
      <div className="flex flex-col items-center gap-5 px-6 py-8 text-center">
        <div className={clsx(
          'w-14 h-14 rounded-full flex items-center justify-center',
          'bg-red-100 text-[28px]'
        )}>
          ✕
        </div>
        <p className="text-r-neutral-title-1 text-[17px] font-semibold">
          Signing Failed
        </p>
        <div className="w-full rounded-[10px] bg-r-neutral-bg2 p-4">
          <p className="text-r-neutral-foot text-[13px] break-words leading-relaxed">
            {errorMsg}
          </p>
        </div>
        <button
          onClick={() => rejectApproval('User cancelled MPC signing')}
          className={clsx(
            'w-full h-12 rounded-[10px]',
            'bg-r-neutral-bg2 text-r-neutral-title-1',
            'text-[15px] font-medium',
            'hover:opacity-80 transition-opacity'
          )}
        >
          Cancel
        </button>
      </div>
    );
  }

  // ── Render: in-progress ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center gap-5 px-6 py-8 text-center">
      {/* Animated BLE status indicator */}
      <BLEStatusIndicator status={bleStatus} />

      <p className="text-r-neutral-title-1 text-[16px] font-medium">
        {statusText}
      </p>

      {/* Extra guidance when waiting for phone */}
      {bleStatus === BLEStatus.SCANNING && (
        <p className="text-r-neutral-foot text-[13px] max-w-[260px] leading-relaxed">
          Keep your phone and computer within Bluetooth range (~10 m).
        </p>
      )}

      {/* BLE status badge */}
      <BLEStatusBadge status={bleStatus} />

      {/* Cancel only available while scanning */}
      {bleStatus === BLEStatus.SCANNING && (
        <button
          onClick={() => rejectApproval('User cancelled MPC signing')}
          className="text-r-neutral-foot text-[13px] underline mt-2"
        >
          Cancel
        </button>
      )}
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const BLEStatusIndicator: React.FC<{ status: BLEStatus }> = ({ status }) => {
  const spinning = [
    BLEStatus.SCANNING,
    BLEStatus.CONNECTING,
    BLEStatus.CONNECTED,
    BLEStatus.IDLE,
  ].includes(status);

  const done = status === BLEStatus.DISCONNECTED;
  const error = status === BLEStatus.ERROR || status === BLEStatus.TIMEOUT;

  return (
    <div className={clsx(
      'w-14 h-14 rounded-full border-4',
      spinning && 'border-r-blue-default border-t-transparent animate-spin',
      done && 'border-r-green-light',
      error && 'border-red-500',
    )} />
  );
};

const statusLabels: Partial<Record<BLEStatus, string>> = {
  [BLEStatus.IDLE]:         'Idle',
  [BLEStatus.SCANNING]:     'Waiting for phone',
  [BLEStatus.CONNECTING]:   'Connecting',
  [BLEStatus.CONNECTED]:    'Connected',
  [BLEStatus.DISCONNECTED]: 'Done',
  [BLEStatus.TIMEOUT]:      'Timed out',
  [BLEStatus.ERROR]:        'Error',
};

const BLEStatusBadge: React.FC<{ status: BLEStatus }> = ({ status }) => {
  const label = statusLabels[status];
  if (!label) return null;

  const isError = status === BLEStatus.ERROR || status === BLEStatus.TIMEOUT;
  const isDone  = status === BLEStatus.DISCONNECTED;

  return (
    <span className={clsx(
      'px-3 py-1 rounded-full text-[12px] font-medium',
      isError ? 'bg-red-100 text-red-700' : '',
      isDone  ? 'bg-r-green-light text-green-700' : '',
      !isError && !isDone ? 'bg-r-blue-light text-r-blue-default' : '',
    )}>
      BLE: {label}
    </span>
  );
};

export default MPCWaiting;
