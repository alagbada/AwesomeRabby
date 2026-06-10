/**
 * PrismTx MPC Pairing Page  (/mpc-pairing)
 *
 * One-time setup ceremony that creates a 2-of-2 MPC wallet between the
 * browser extension (Party 1) and the PrismTx Key mobile app (Party 2).
 *
 * Step flow:
 *
 *  SHOW_QR     Show QR code → user scans with PrismTx Key
 *     ↓
 *  SCANNING    User clicks "Connect Phone" → BLE device picker opens
 *     ↓
 *  CONNECTING  gatt.connect() in progress
 *     ↓
 *  KEYGEN      DKG rounds running over BLE (~1 second)
 *     ↓
 *  CONFIRM     Show derived wallet address — user verifies it matches phone
 *     ↓
 *  SAVING      wallet.addMPCAccount() persists to encrypted vault
 *     ↓
 *  SUCCESS     Redirect to dashboard
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import QRCode from 'qrcode.react';
import clsx from 'clsx';
import { useWallet } from '@/ui/utils/WalletContext';
import {
  generateSessionKey,
  generateSessionId,
  pairNewDevice,
  BLEStatus,
} from '@/ui/utils/BLE/bleService';
import { runKeyGenP1 } from '@/ui/utils/BLE/tssCoordinator';
import { PhoneStatus } from '@/ui/utils/BLE/gattProfile';

// ─── Pairing step state machine ──────────────────────────────────────────────

type PairingStep =
  | 'show_qr'
  | 'scanning'
  | 'connecting'
  | 'keygen'
  | 'confirm'
  | 'saving'
  | 'success'
  | 'error';

// ─── QR payload (scanned by PrismTx Key mobile app) ─────────────────────────

interface PairingQRPayload {
  /** Protocol version */
  v: 1;
  /** Unique session ID — ties QR scan to this specific pairing attempt */
  sid: string;
  /** AES-256 session key (base64) — used to encrypt all BLE messages */
  key: string;
  /** Random UUID the phone advertises after scanning, so extension finds it */
  fid: string;
  /** App identifier */
  app: 'PrismTx';
}

// ─── Component ────────────────────────────────────────────────────────────────

export const MPCPairing: React.FC<{
  isInModal?: boolean;
  onBack?: () => void;
  onNavigate?: (type: string, state?: Record<string, any>) => void;
}> = ({ isInModal, onBack, onNavigate }) => {
  const wallet = useWallet();
  const history = useHistory();
  const location = useLocation<{ successRoute?: string }>();
  // Optional override for where to navigate on success (used by new-user onboarding)
  const successRoute = location.state?.successRoute ?? '/dashboard';

  // ── Pairing session state ──────────────────────────────────────────────────
  const [step, setStep] = useState<PairingStep>('show_qr');
  const [bleStatus, setBle] = useState<BLEStatus>(BLEStatus.IDLE);
  const [phoneStatus, setPhone] = useState<PhoneStatus | null>(null);
  const [address, setAddress] = useState<string>('');
  const [pubKeyHex, setPubKey] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [qrPayload, setQrPayload] = useState<string>('');

  // Signing context built once per page load — stable across renders
  const sessionRef = useRef<{
    sessionId: string;
    sessionKeyB64: string;
    bleFilterUUID: string;
    qrPayload: string;
  } | null>(null);

  // Key generation result — held in ref until user confirms
  const keyGenRef = useRef<{
    keyShare1Json: string;
    deviceId: string;
  } | null>(null);

  // ── Generate QR payload on mount ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const sessionId = generateSessionId();
      const sessionKeyB64 = await generateSessionKey();
      const bleFilterUUID = crypto.randomUUID();

      if (cancelled) return;

      const payload: PairingQRPayload = {
        v: 1,
        sid: sessionId,
        key: sessionKeyB64,
        fid: bleFilterUUID,
        app: 'PrismTx',
      };

      const qrPayloadStr = JSON.stringify(payload);

      sessionRef.current = {
        sessionId,
        sessionKeyB64,
        bleFilterUUID,
        qrPayload: qrPayloadStr,
      };

      setQrPayload(qrPayloadStr);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── BLE + DKG flow (triggered by button click — required for user gesture) ─
  const handleConnect = async () => {
    const session = sessionRef.current;
    if (!session) return;

    setError('');

    try {
      // Step: open device picker
      setStep('scanning');

      const { service, deviceId } = await pairNewDevice(
        session.bleFilterUUID,
        session.sessionKeyB64,
        (s) => {
          setBle(s);
          if (s === BLEStatus.CONNECTING) setStep('connecting');
          if (s === BLEStatus.CONNECTED) setStep('keygen');
        }
      );

      service['onPhoneStatus'] = (status: PhoneStatus) => {
        setPhone(status);
      };

      // Step: run DKG
      setStep('keygen');
      const result = await runKeyGenP1(service, session.sessionId);

      service.disconnect();

      // Store result for confirmation step
      keyGenRef.current = {
        keyShare1Json: result.keyShare1Json,
        deviceId,
      };

      setAddress(result.address);
      setPubKey(result.publicKeyHex);
      setStep('confirm');
    } catch (err: any) {
      setError(err?.message ?? 'An unexpected error occurred during pairing.');
      setStep('error');
    }
  };

  // ── Save account after user confirms address ───────────────────────────────
  const handleConfirm = async () => {
    const session = sessionRef.current;
    const keyGen = keyGenRef.current;
    if (!session || !keyGen) return;

    setStep('saving');
    setError('');

    try {
      await wallet.addMPCAccount({
        address,
        keyShare1Json: keyGen.keyShare1Json,
        pairedDeviceId: keyGen.deviceId,
        sessionKeyB64: session.sessionKeyB64,
        publicKeyHex: pubKeyHex,
      });
      setStep('success');
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save MPC account.');
      setStep('error');
    }
  };

  const handleRetry = () => {
    setStep('show_qr');
    setBle(BLEStatus.IDLE);
    setPhone(null);
    setError('');
    keyGenRef.current = null;
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center',
        isInModal ? 'px-6 py-8' : 'min-h-screen bg-r-neutral-bg1 px-6 py-10'
      )}
    >
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-r-neutral-title-1 text-[24px] font-bold leading-tight">
          Set Up MPC Wallet
        </h1>
        <p className="text-r-neutral-foot text-[14px] mt-2">
          Pair with PrismTx Key to create your 2-of-2 secure wallet
        </p>
      </div>

      {/* Step: show QR */}
      {step === 'show_qr' && (
        <StepShowQR qrPayload={qrPayload} onConnect={handleConnect} />
      )}

      {/* Steps: scanning / connecting */}
      {(step === 'scanning' || step === 'connecting') && (
        <StepProgress
          title={
            step === 'scanning'
              ? 'Opening Bluetooth scanner…'
              : 'Connecting to phone…'
          }
          subtitle={
            step === 'scanning'
              ? 'Select your phone from the list'
              : 'Establishing secure connection'
          }
        />
      )}

      {/* Step: keygen */}
      {step === 'keygen' && (
        <StepProgress
          title="Generating your wallet…"
          subtitle="Running key generation protocol. This takes about 1 second."
          phoneStatus={phoneStatus}
        />
      )}

      {/* Step: confirm */}
      {step === 'confirm' && (
        <StepConfirm
          address={address}
          onConfirm={handleConfirm}
          onRetry={handleRetry}
        />
      )}

      {/* Step: saving */}
      {step === 'saving' && (
        <StepProgress
          title="Saving your wallet…"
          subtitle="Storing your key share securely."
        />
      )}

      {/* Step: success */}
      {step === 'success' && (
        <StepSuccess
          address={address}
          onDone={() => {
            if (isInModal) {
              onNavigate?.('done');
            } else {
              history.push(successRoute);
            }
          }}
        />
      )}

      {/* Step: error */}
      {step === 'error' && <StepError message={error} onRetry={handleRetry} />}
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────────────────

const StepShowQR: React.FC<{
  qrPayload: string;
  onConnect: () => void;
}> = ({ qrPayload, onConnect }) => (
  <div className="flex flex-col items-center gap-6">
    <div
      className={clsx(
        'bg-white p-4 rounded-[16px]',
        'shadow-[0px_8px_24px_rgba(25,41,69,0.12)]'
      )}
    >
      {qrPayload ? (
        <QRCode value={qrPayload} size={240} level="M" />
      ) : (
        <div className="w-[240px] h-[240px] bg-r-neutral-bg2 rounded animate-pulse" />
      )}
    </div>

    <div className="text-center max-w-[280px]">
      <p className="text-r-neutral-title-1 text-[15px] font-medium">
        1. Open PrismTx Key on your phone
      </p>
      <p className="text-r-neutral-foot text-[13px] mt-1">
        2. Tap "Pair with Extension" and scan this QR
      </p>
      <p className="text-r-neutral-foot text-[13px] mt-1">
        3. Click the button below once your phone shows "Ready"
      </p>
    </div>

    <button
      onClick={onConnect}
      disabled={!qrPayload}
      className={clsx(
        'w-full max-w-[280px] h-[52px] rounded-[10px]',
        'bg-r-blue-default text-white',
        'text-[16px] font-medium',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        'hover:opacity-90 transition-opacity'
      )}
    >
      Connect Phone
    </button>
  </div>
);

const StepProgress: React.FC<{
  title: string;
  subtitle: string;
  phoneStatus?: PhoneStatus | null;
}> = ({ title, subtitle, phoneStatus }) => (
  <div className="flex flex-col items-center gap-4 text-center">
    {/* Spinner */}
    <div
      className={clsx(
        'w-[56px] h-[56px] rounded-full border-4',
        'border-r-blue-default border-t-transparent',
        'animate-spin'
      )}
    />
    <p className="text-r-neutral-title-1 text-[17px] font-medium">{title}</p>
    <p className="text-r-neutral-foot text-[13px] max-w-[240px]">{subtitle}</p>
    {phoneStatus && (
      <span
        className={clsx(
          'px-3 py-1 rounded-full text-[12px]',
          'bg-r-blue-light text-r-blue-default'
        )}
      >
        Phone: {phoneStatus}
      </span>
    )}
  </div>
);

const StepConfirm: React.FC<{
  address: string;
  onConfirm: () => void;
  onRetry: () => void;
}> = ({ address, onConfirm, onRetry }) => (
  <div className="flex flex-col items-center gap-6 w-full max-w-[360px]">
    <div
      className={clsx(
        'w-full rounded-[12px] p-5',
        'bg-r-neutral-bg2 border border-rabby-neutral-line'
      )}
    >
      <p className="text-r-neutral-foot text-[12px] mb-1">
        Your new wallet address
      </p>
      <p className="text-r-neutral-title-1 text-[13px] font-mono break-all leading-relaxed">
        {address}
      </p>
    </div>

    <div
      className={clsx(
        'w-full rounded-[10px] p-4',
        'bg-orange-50 border border-orange-200'
      )}
    >
      <p className="text-orange-700 text-[13px] leading-relaxed">
        ⚠️ Verify this address matches what is shown on your phone before
        confirming.
      </p>
    </div>

    <button
      onClick={onConfirm}
      className={clsx(
        'w-full h-[52px] rounded-[10px]',
        'bg-r-blue-default text-white',
        'text-[16px] font-medium',
        'hover:opacity-90 transition-opacity'
      )}
    >
      Address matches — Save Wallet
    </button>

    <button
      onClick={onRetry}
      className="text-r-neutral-foot text-[13px] underline"
    >
      Address doesn't match — start over
    </button>
  </div>
);

const StepSuccess: React.FC<{
  address: string;
  onDone: () => void;
}> = ({ address, onDone }) => (
  <div className="flex flex-col items-center gap-6 text-center w-full max-w-[360px]">
    <div
      className={clsx(
        'w-[64px] h-[64px] rounded-full',
        'bg-r-green-light flex items-center justify-center'
      )}
    >
      <span className="text-[32px]">✓</span>
    </div>

    <div>
      <p className="text-r-neutral-title-1 text-[20px] font-bold">
        Wallet created!
      </p>
      <p className="text-r-neutral-foot text-[13px] mt-2 font-mono break-all">
        {address}
      </p>
    </div>

    <p className="text-r-neutral-foot text-[13px] max-w-[280px]">
      Every transaction now requires approval from both your browser and your
      phone.
    </p>

    <button
      onClick={onDone}
      className={clsx(
        'w-full h-[52px] rounded-[10px]',
        'bg-r-blue-default text-white',
        'text-[16px] font-medium',
        'hover:opacity-90 transition-opacity'
      )}
    >
      Go to Dashboard
    </button>
  </div>
);

const StepError: React.FC<{
  message: string;
  onRetry: () => void;
}> = ({ message, onRetry }) => (
  <div className="flex flex-col items-center gap-6 text-center w-full max-w-[360px]">
    <div
      className={clsx(
        'w-[64px] h-[64px] rounded-full',
        'bg-red-100 flex items-center justify-center'
      )}
    >
      <span className="text-[32px]">✕</span>
    </div>

    <p className="text-r-neutral-title-1 text-[17px] font-medium">
      Pairing failed
    </p>

    <div className="w-full rounded-[10px] bg-r-neutral-bg2 p-4">
      <p className="text-r-neutral-foot text-[13px] break-words">{message}</p>
    </div>

    <button
      onClick={onRetry}
      className={clsx(
        'w-full h-[52px] rounded-[10px]',
        'bg-r-blue-default text-white',
        'text-[16px] font-medium',
        'hover:opacity-90 transition-opacity'
      )}
    >
      Try Again
    </button>
  </div>
);

export default MPCPairing;
