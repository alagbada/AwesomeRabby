import React from 'react';
import { useHistory } from 'react-router-dom';
import { PasswordCard } from './PasswordCard';
import { useWallet } from '@/ui/utils';
import { useMemoizedFn, useMount } from 'ahooks';
import { message } from 'antd';

/**
 * Step 2 of the "Create MPC Wallet" new-user flow.
 *
 * The user sets a password here (same UX as CreateSeedPhrase).
 * On submit we boot the wallet, then hand off to the MPC pairing page.
 * The pairing page is told to redirect to /new-user/success on completion
 * via history state so the normal success screen can open the popup.
 */
export const CreateMPCWallet = () => {
  const wallet = useWallet();
  const history = useHistory();

  const handleSubmit = useMemoizedFn(async (password: string) => {
    try {
      await wallet.boot(password);
      // Hand off to the MPC pairing flow; tell it where to go on success.
      history.push('/mpc-pairing', { successRoute: '/new-user/success' });
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
      message.error('Password already set — please open the PrismTx popup');
      setTimeout(() => window.close(), 1000);
    }
  });

  return <PasswordCard onBack={handleBack} onSubmit={handleSubmit} />;
};
