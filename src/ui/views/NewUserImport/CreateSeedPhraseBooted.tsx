/**
 * CreateSeedPhraseBooted
 *
 * Reached from CreateWalletType after the wallet is already booted (password
 * was set on the shared CreateWalletPassword screen).  There is nothing more
 * for the user to fill in here — we just generate the mnemonic, create the
 * keyring, and navigate to /new-user/success.
 *
 * A brief "Creating wallet…" state is shown while the async work runs.
 */

import { KEYRING_CLASS } from '@/constant';
import { useRabbyDispatch } from '@/ui/store';
import { useWallet } from '@/ui/utils';
import { useMount } from 'ahooks';
import { message } from 'antd';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { useNewUserGuideStore } from './hooks/useNewUserGuideStore';

export const CreateSeedPhraseBooted = () => {
  const wallet = useWallet();
  const history = useHistory();
  const dispatch = useRabbyDispatch();
  const { setStore } = useNewUserGuideStore();

  useMount(async () => {
    try {
      const seedPhrase = await wallet.generateMnemonic();
      await wallet.createKeyringWithMnemonics(seedPhrase, { hasBackup: false });
      const keyring = await wallet.getKeyringByMnemonic(seedPhrase, '');
      setStore({ seedPhrase, passphrase: '' });

      const stashKeyringId = await wallet.getMnemonicKeyRingIdFromPublicKey(
        keyring!.publicKey!
      );

      dispatch.importMnemonics.switchKeyring({
        stashKeyringId: stashKeyringId as number,
      });

      const accounts = await dispatch.importMnemonics.getAccounts({
        start: 0,
        end: 1,
      });

      await dispatch.importMnemonics.setSelectedAccounts([accounts[0].address]);
      await dispatch.importMnemonics.confirmAllImportingAccountsAsync();

      history.replace({
        pathname: '/new-user/success',
        search: `?hd=${KEYRING_CLASS.MNEMONIC}&keyringId=${stashKeyringId}&isCreated=true`,
      });
    } catch (e: any) {
      console.error(e);
      message.error(e?.message ?? 'Failed to create wallet');
      // Fall back to type chooser so the user can try again
      history.replace('/new-user/create-wallet-type');
    }
  });

  return (
    <div className="flex items-center justify-center min-h-screen">
      <span className="text-r-neutral-title1 text-[15px] font-medium">
        Creating wallet…
      </span>
    </div>
  );
};
