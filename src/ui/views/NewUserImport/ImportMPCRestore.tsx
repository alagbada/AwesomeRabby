/**
 * ImportMPCRestore
 *
 * New-user onboarding screen for restoring an existing MPC wallet from a
 * previously exported .json backup file (created via "Export Key Share Backup"
 * in Address Detail settings).
 *
 * Steps:
 *  1. Upload the .json backup file
 *  2. Enter the backup passphrase (set at export time)
 *  3. Set a new wallet password (boots the vault for first-time install)
 *  4. Submit → decrypt backup → addMPCAccount → /new-user/success
 */

import React, { useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { Card } from '@/ui/component/NewUserImport';
import { useWallet } from '@/ui/utils';
import { useMemoizedFn, useMount } from 'ahooks';
import { Button, Input, message } from 'antd';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ReactComponent as RcAddAddressOptionMPCIcon } from '@/ui/assets/add-address/option-mpc-wallet.svg';

export const ImportMPCRestore = () => {
  const { t } = useTranslation();
  const wallet = useWallet();
  const history = useHistory();

  const [backupJson, setBackupJson] = useState('');
  const [fileName, setFileName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [walletPassword, setWalletPassword] = useState('');
  const [walletPassword2, setWalletPassword2] = useState('');
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setBackupJson((ev.target?.result as string) ?? '');
    reader.readAsText(file);
  };

  const handleSubmit = useMemoizedFn(async () => {
    if (!backupJson) {
      message.error(t('page.newUserImport.importMPCRestore.errorNoFile'));
      return;
    }
    if (!passphrase) {
      message.error(t('page.newUserImport.importMPCRestore.errorNoPassphrase'));
      return;
    }
    if (!walletPassword) {
      message.error(t('page.newUserImport.importMPCRestore.errorNoPassword'));
      return;
    }
    if (walletPassword !== walletPassword2) {
      message.error(
        t('page.newUserImport.importMPCRestore.errorPasswordMismatch')
      );
      return;
    }
    if (walletPassword.length < 8) {
      message.error(
        t('page.newUserImport.importMPCRestore.errorPasswordTooShort')
      );
      return;
    }

    setLoading(true);
    try {
      await wallet.boot(walletPassword);
      await wallet.importMPCAccountFromBackup(backupJson, passphrase);
      history.push('/new-user/success');
    } catch (e: any) {
      message.error(
        e?.message ?? t('page.newUserImport.importMPCRestore.errorGeneric')
      );
    } finally {
      setLoading(false);
    }
  });

  useMount(async () => {
    const isBooted = await wallet.isBooted();
    if (isBooted) {
      message.error('Password already set — please open the PrismTx popup');
      setTimeout(() => window.close(), 1000);
    }
  });

  return (
    <Card
      onBack={() =>
        history.length > 1
          ? history.goBack()
          : history.replace('/new-user/import-wallet-type')
      }
      title={t('page.newUserImport.importMPCRestore.title')}
    >
      <div className="flex flex-col gap-[14px] mt-[20px] px-[2px]">
        {/* Header icon + subtitle */}
        <div className="flex items-center gap-[10px] mb-[4px]">
          <RcAddAddressOptionMPCIcon className="w-[20px] h-[20px] shrink-0 text-r-neutral-foot" />
          <p className="text-[13px] text-r-neutral-foot m-0 leading-snug">
            {t('page.newUserImport.importMPCRestore.subtitle')}
          </p>
        </div>

        {/* ── Backup file ── */}
        <div>
          <div className="text-[12px] font-medium text-r-neutral-body mb-[6px]">
            {t('page.newUserImport.importMPCRestore.fileLabel')}
          </div>
          <div
            className={clsx(
              'flex items-center gap-[10px] px-[14px] py-[12px]',
              'border-2 border-dashed rounded-[8px] cursor-pointer transition-colors',
              backupJson
                ? 'border-r-blue-default bg-r-blue-light-1'
                : 'border-r-neutral-line bg-r-neutral-card2 hover:border-r-blue-default'
            )}
            onClick={() => fileRef.current?.click()}
          >
            <span className="text-[13px] text-r-neutral-title1 truncate flex-1 leading-tight">
              {fileName ||
                t('page.newUserImport.importMPCRestore.filePlaceholder')}
            </span>
            <Button size="small" className="shrink-0">
              {t('page.newUserImport.importMPCRestore.browse')}
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* ── Backup passphrase ── */}
        <div>
          <div className="text-[12px] font-medium text-r-neutral-body mb-[6px]">
            {t('page.newUserImport.importMPCRestore.passphraseLabel')}
          </div>
          <Input.Password
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t(
              'page.newUserImport.importMPCRestore.passphrasePlaceholder'
            )}
            size="large"
          />
        </div>

        {/* ── Wallet password ── */}
        <div>
          <div className="text-[12px] font-medium text-r-neutral-body mb-[6px]">
            {t('page.newUserImport.importMPCRestore.passwordLabel')}
          </div>
          <Input.Password
            value={walletPassword}
            onChange={(e) => setWalletPassword(e.target.value)}
            placeholder={t(
              'page.newUserImport.importMPCRestore.passwordPlaceholder'
            )}
            size="large"
            className="mb-[8px]"
          />
          <Input.Password
            value={walletPassword2}
            onChange={(e) => setWalletPassword2(e.target.value)}
            onPressEnter={handleSubmit}
            placeholder={t(
              'page.newUserImport.importMPCRestore.passwordConfirmPlaceholder'
            )}
            size="large"
          />
        </div>

        <Button
          type="primary"
          size="large"
          block
          loading={loading}
          disabled={
            !backupJson || !passphrase || !walletPassword || !walletPassword2
          }
          onClick={handleSubmit}
          className="mt-[4px] h-[52px] rounded-[8px] text-[15px] font-medium shadow-none"
        >
          {t('page.newUserImport.importMPCRestore.restoreButton')}
        </Button>
      </div>
    </Card>
  );
};
