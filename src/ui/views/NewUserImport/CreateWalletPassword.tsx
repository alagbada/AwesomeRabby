/**
 * CreateWalletPassword
 *
 * Step 1 of the "Create New Wallet" new-user flow (shared for both MPC and
 * seed-phrase wallets).  The user sets their wallet password here; on submit
 * the vault is booted and the user is taken to CreateWalletType to pick which
 * kind of wallet they want.
 */

import React from 'react';
import { useHistory } from 'react-router-dom';
import { PasswordCard } from './PasswordCard';
import { useWallet } from '@/ui/utils';
import { useMemoizedFn, useMount } from 'ahooks';
import { message } from 'antd';

export const CreateWalletPassword = () => {
  const wallet  = useWallet();
  const history = useHistory();

  const handleSubmit = useMemoizedFn(async (password: string) => {
    try {
      await wallet.boot(password);
      history.push('/new-user/create-wallet-type');
    } catch (e: any) {
      console.error(e);
      message.error(e?.message ?? 'Failed to set password');
    }
  });

  const handleBack = useMemoizedFn(() => {
    if (history.length > 1) {
      history.goBack();
    } else {
      window.close();
    }
  });

  useMount(async () => {
    const isBooted = await wallet.isBooted();
    if (isBooted) {
      message.error('already set password, please click rabby popup');
      setTimeout(() => window.close(), 1000);
    }
  });

  return <PasswordCard onBack={handleBack} onSubmit={handleSubmit} />;
};
