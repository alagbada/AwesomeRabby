import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { Drawer } from 'antd';
import { useWallet }        from '@/ui/utils';
import { useIntentParser }  from './useIntentParser';
import { useIntentExecutor } from './useIntentExecutor';
import type { IntentChain } from './intentTypes';
import './style.less';

// ─── helpers ──────────────────────────────────────────────────────────────────

function confidenceLabel(c: number): string {
  if (c >= 0.85) return 'High';
  if (c >= 0.65) return 'Medium';
  return 'Low';
}

function confidenceColor(c: number): string {
  if (c >= 0.85) return '#27C193';
  if (c >= 0.65) return '#FFB020';
  return '#FF6B6B';
}

async function getApiBase(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['awesome_api_url'], (data) => {
      resolve((data.awesome_api_url as string | undefined) ?? 'http://localhost:3000');
    });
  });
}

// ─── useVoice ─────────────────────────────────────────────────────────────────
// Handles MediaRecorder in the popup context. On stop, sends audio bytes to
// rabby-api /v1/ai/transcribe (managed Groq Whisper) and returns the transcript.

function useVoice() {
  const [isRecording,    setIsRecording]    = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceError,     setVoiceError]     = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef   = useRef<Blob[]>([]);
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startVoice = async () => {
    setVoiceError(null);
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      chunksRef.current   = [];
      const recorder      = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      setIsRecording(true);

      // Auto-stop after 60 s
      timerRef.current = setTimeout(() => stopVoice(), 60_000);
    } catch {
      setVoiceError('Microphone access denied. Allow mic access and try again.');
    }
  };

  const stopVoice = async (): Promise<string | null> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }

    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setIsRecording(false);
      return null;
    }

    return new Promise((resolve) => {
      const mimeType = recorder.mimeType;

      recorder.onstop = async () => {
        recorder.stream?.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        setIsRecording(false);

        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < 500) {
          setVoiceError('Recording was too short — nothing captured.');
          resolve(null);
          return;
        }

        setIsTranscribing(true);
        try {
          const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
          const base  = await getApiBase();
          const res   = await fetch(`${base}/v1/ai/transcribe`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ audioBytes: bytes, mimeType }),
          });

          if (!res.ok) {
            const err: any = await res.json().catch(() => ({}));
            throw new Error(err?.error ?? `Transcription error ${res.status}`);
          }

          const json: any = await res.json();
          resolve(json.transcript ?? null);
        } catch (e: any) {
          setVoiceError(e?.message ?? 'Transcription failed');
          resolve(null);
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.stop();
    });
  };

  const clearVoiceError = () => setVoiceError(null);

  return { isRecording, isTranscribing, voiceError, startVoice, stopVoice, clearVoiceError };
}

// ─── AISheet ──────────────────────────────────────────────────────────────────

interface AISheetProps {
  open: boolean;
  onClose: () => void;
  chain?: string;
}

export function AISheet({ open, onClose }: AISheetProps) {
  const wallet  = useWallet();
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Current account address — needed by executor to build txs
  const [walletAddress, setWalletAddress] = useState('');
  useEffect(() => {
    wallet.getCurrentAccount().then((acc: any) => {
      if (acc?.address) setWalletAddress(acc.address);
    }).catch(() => {});
  }, [wallet]);

  const {
    stage:  parseStage, intent, error: parseError,
    parse, reset: resetParser,
  } = useIntentParser();

  const {
    stage:  execStage, swapQuote, sendDetails, error: execError,
    build, execute, reset: resetExecutor,
  } = useIntentExecutor(walletAddress);

  const {
    isRecording, isTranscribing, voiceError,
    startVoice, stopVoice, clearVoiceError,
  } = useVoice();

  // ── handlers ────────────────────────────────────────────────────────────────

  const handleAsk = () => {
    const text = textRef.current?.value ?? '';
    resetExecutor();
    clearVoiceError();
    parse(text, 'ethereum' as IntentChain);
  };

  const handleVoice = async () => {
    if (isRecording) {
      const transcript = await stopVoice();
      if (transcript && textRef.current) {
        textRef.current.value = transcript;
        // Auto-parse after successful transcription
        resetExecutor();
        clearVoiceError();
        parse(transcript, 'ethereum' as IntentChain);
      }
    } else {
      await startVoice();
    }
  };

  /** Step 1: parse produced an intent — now build the transaction. */
  const handleBuild = () => {
    if (!intent) return;
    build(intent);
  };

  /** Step 2: transaction is built — sign it. */
  const handleExecute = () => {
    execute(wallet);
  };

  const handleClose = () => {
    resetParser();
    resetExecutor();
    if (textRef.current) textRef.current.value = '';
    onClose();
  };

  const handleBack = () => {
    resetExecutor();
  };

  // ── derived state ────────────────────────────────────────────────────────────

  const isParsing  = parseStage === 'parsing';
  const hasPreview = parseStage === 'preview' && intent;
  const hasError   = (parseStage === 'error') || execStage === 'error';
  const errorMsg   = execError ?? parseError;

  const canBuild =
    hasPreview &&
    intent.action !== 'unknown' &&
    intent.action !== 'approve' &&
    intent.action !== 'bridge' &&
    intent.action !== 'fund' &&
    intent.confidence >= 0.5 &&
    execStage === 'idle';

  const isBuilding  = execStage === 'building';
  const txReady     = execStage === 'ready';
  const isSigning   = execStage === 'signing';
  const isSuccess   = execStage === 'success';

  const inputBusy = isParsing || isRecording || isTranscribing;

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <Drawer
      open={open}
      onClose={handleClose}
      placement="bottom"
      closable={false}
      height="auto"
      className="ai-sheet"
      destroyOnClose={false}
    >
      {/* ── Header ── */}
      <div className="ai-sheet__header">
        <span className="ai-sheet__title">
          <span className="ai-sheet__spark">✦</span> AI Assistant
        </span>
        <div className="ai-sheet__header-right">
          <button className="ai-sheet__close" onClick={handleClose}>✕</button>
        </div>
      </div>

      {/* ── Input area (hidden while building / signing / success) ── */}
      {!isBuilding && !txReady && !isSigning && !isSuccess && (
        <div className="ai-sheet__input-wrap">
          <textarea
            ref={textRef}
            className="ai-sheet__textarea"
            placeholder={'What do you want to do?\n\n"Swap 0.2 ETH for USDT"\n"Send 100 USDC to alice.eth"'}
            rows={3}
            disabled={inputBusy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleAsk();
              }
            }}
          />

          {/* Mic button */}
          <button
            className={clsx(
              'ai-sheet__mic-btn',
              isRecording   && 'recording',
              isTranscribing && 'transcribing',
            )}
            onClick={handleVoice}
            disabled={isParsing}
            title={isRecording ? 'Stop recording' : 'Voice input'}
          >
            {isTranscribing
              ? <span className="ai-sheet__spinner" />
              : isRecording
                ? '◼'
                : '🎤'}
          </button>

          {/* Send button */}
          <button
            className={clsx('ai-sheet__ask-btn', isParsing && 'loading')}
            onClick={handleAsk}
            disabled={inputBusy}
          >
            {isParsing ? <span className="ai-sheet__spinner" /> : '→'}
          </button>
        </div>
      )}

      {/* ── Voice indicator ── */}
      {(isRecording || isTranscribing) && (
        <div className={clsx('ai-sheet__voice-indicator', isTranscribing && 'transcribing')}>
          {isRecording && (
            <span className="ai-sheet__voice-waves">
              <span /><span /><span /><span />
            </span>
          )}
          <span className="ai-sheet__voice-label">
            {isRecording ? 'Listening… tap ◼ to stop' : 'Transcribing…'}
          </span>
        </div>
      )}

      {/* ── Voice error ── */}
      {voiceError && !isRecording && !isTranscribing && (
        <div className="ai-sheet__error">
          🎤 {voiceError}
          <button className="ai-sheet__retry" onClick={clearVoiceError}>Dismiss</button>
        </div>
      )}

      {/* ── Parse / exec error ── */}
      {hasError && !voiceError && (
        <div className="ai-sheet__error">
          {errorMsg}
          <button className="ai-sheet__retry" onClick={() => { resetParser(); resetExecutor(); }}>
            Try again
          </button>
        </div>
      )}

      {/* ── Intent preview + Build button ── */}
      {hasPreview && !isBuilding && !txReady && !isSigning && !isSuccess && (
        <div className="ai-sheet__preview">
          <div className="ai-sheet__summary">{intent.summary}</div>

          <div className="ai-sheet__rows">
            <div className="ai-sheet__row">
              <span className="ai-sheet__row-key">ACTION</span>
              <span className="ai-sheet__row-val">{intent.action.toUpperCase()}</span>
            </div>
            <div className="ai-sheet__row">
              <span className="ai-sheet__row-key">CHAIN</span>
              <span className="ai-sheet__row-val">{intent.chain.toUpperCase()}</span>
            </div>

            {intent.action === 'swap' ? (
              <>
                {intent.fromToken && (
                  <div className="ai-sheet__row">
                    <span className="ai-sheet__row-key">SELL</span>
                    <span className="ai-sheet__row-val">
                      {intent.amount != null ? `${intent.amount} ` : ''}{intent.fromToken}
                    </span>
                  </div>
                )}
                {intent.toToken && (
                  <div className="ai-sheet__row">
                    <span className="ai-sheet__row-key">BUY</span>
                    <span className="ai-sheet__row-val">{intent.toToken}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                {intent.token && (
                  <div className="ai-sheet__row">
                    <span className="ai-sheet__row-key">TOKEN</span>
                    <span className="ai-sheet__row-val">
                      {intent.amount != null ? `${intent.amount} ` : ''}{intent.token}
                    </span>
                  </div>
                )}
                {(intent.toAddress || intent.toName) && (
                  <div className="ai-sheet__row">
                    <span className="ai-sheet__row-key">TO</span>
                    <span
                      className="ai-sheet__row-val ai-sheet__row-val--addr"
                      title={intent.toAddress ?? intent.toName ?? ''}
                    >
                      {intent.toAddress ?? intent.toName}
                    </span>
                  </div>
                )}
              </>
            )}

            <div className="ai-sheet__row">
              <span className="ai-sheet__row-key">CONFIDENCE</span>
              <span
                className="ai-sheet__row-val"
                style={{ color: confidenceColor(intent.confidence) }}
              >
                {confidenceLabel(intent.confidence)} ({Math.round(intent.confidence * 100)}%)
              </span>
            </div>
          </div>

          {intent.missingInfo.length > 0 && (
            <div className="ai-sheet__missing">
              Missing: {intent.missingInfo.join(', ')}
            </div>
          )}

          <div className="ai-sheet__actions">
            <button className="ai-sheet__btn ai-sheet__btn--ghost" onClick={resetParser}>
              ← Back
            </button>
            <button
              className={clsx('ai-sheet__btn ai-sheet__btn--primary', !canBuild && 'disabled')}
              disabled={!canBuild}
              onClick={handleBuild}
            >
              Build Transaction →
            </button>
          </div>
        </div>
      )}

      {/* ── Building spinner ── */}
      {isBuilding && (
        <div className="ai-sheet__building">
          <span className="ai-sheet__spinner" />
          <span className="ai-sheet__building-label">Getting best quote…</span>
        </div>
      )}

      {/* ── Transaction ready — show quote, await confirmation ── */}
      {txReady && (
        <div className="ai-sheet__preview">

          {/* Natural-language response bubble */}
          <div className="ai-sheet__response-bubble">
            <span className="ai-sheet__spark">✦</span>
            {swapQuote && (
              <span>
                Got it. You'll swap{' '}
                <strong>{swapQuote.fromAmount}</strong> and receive approximately{' '}
                <strong>{swapQuote.toAmount}</strong> ({swapQuote.rate}).
                Estimated gas: {swapQuote.gasUnits}, slippage capped at {swapQuote.slippage}.
                Confirm below to sign.
              </span>
            )}
            {sendDetails && (
              <span>
                Ready to send <strong>{sendDetails.amount}</strong> to{' '}
                <strong className="ai-sheet__addr-inline" title={sendDetails.to}>
                  {sendDetails.to.length > 20
                    ? `${sendDetails.to.slice(0, 10)}…${sendDetails.to.slice(-8)}`
                    : sendDetails.to}
                </strong>.
                Confirm below to sign.
              </span>
            )}
          </div>

          <div className="ai-sheet__rows">
            {/* Swap quote details */}
            {swapQuote && (
              <>
                <div className="ai-sheet__row">
                  <span className="ai-sheet__row-key">SELL</span>
                  <span className="ai-sheet__row-val">{swapQuote.fromAmount}</span>
                </div>
                <div className="ai-sheet__row">
                  <span className="ai-sheet__row-key">RECEIVE</span>
                  <span className="ai-sheet__row-val ai-sheet__row-val--highlight">
                    {swapQuote.toAmount}
                  </span>
                </div>
                <div className="ai-sheet__row">
                  <span className="ai-sheet__row-key">RATE</span>
                  <span className="ai-sheet__row-val">{swapQuote.rate}</span>
                </div>
                <div className="ai-sheet__row">
                  <span className="ai-sheet__row-key">GAS</span>
                  <span className="ai-sheet__row-val">{swapQuote.gasUnits}</span>
                </div>
                <div className="ai-sheet__row">
                  <span className="ai-sheet__row-key">SLIPPAGE</span>
                  <span className="ai-sheet__row-val">{swapQuote.slippage}</span>
                </div>
              </>
            )}

            {/* Send details */}
            {sendDetails && (
              <>
                <div className="ai-sheet__row">
                  <span className="ai-sheet__row-key">SENDING</span>
                  <span className="ai-sheet__row-val">{sendDetails.amount}</span>
                </div>
                <div className="ai-sheet__row">
                  <span className="ai-sheet__row-key">TO</span>
                  <span
                    className="ai-sheet__row-val ai-sheet__row-val--addr"
                    title={sendDetails.to}
                  >
                    {sendDetails.to}
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="ai-sheet__actions">
            <button className="ai-sheet__btn ai-sheet__btn--ghost" onClick={handleBack}>
              ← Back
            </button>
            <button
              className="ai-sheet__btn ai-sheet__btn--primary"
              onClick={handleExecute}
            >
              Confirm &amp; Sign →
            </button>
          </div>
        </div>
      )}

      {/* ── Signing in progress ── */}
      {isSigning && (
        <div className="ai-sheet__building">
          <span className="ai-sheet__spinner" />
          <span className="ai-sheet__building-label">Waiting for signature…</span>
        </div>
      )}

      {/* ── Success ── */}
      {isSuccess && (
        <div className="ai-sheet__success">
          <div className="ai-sheet__success-icon">✓</div>
          <div className="ai-sheet__success-label">Transaction submitted!</div>
          <button className="ai-sheet__btn ai-sheet__btn--ghost" onClick={handleClose}>
            Done
          </button>
        </div>
      )}
    </Drawer>
  );
}
