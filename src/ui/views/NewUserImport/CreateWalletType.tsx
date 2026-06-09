import { Item } from '@/ui/component';
import { Card } from '@/ui/component/NewUserImport';
import {
  RcAddAddressOptionMPCIcon,
  RcAddAddressOptionSeedPhraseIcon,
} from '@/ui/assets/add-address';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useHistory } from 'react-router-dom';

export const CreateWalletType = () => {
  const { t } = useTranslation();
  const history = useHistory();

  return (
    <Card
      className="relative"
      onBack={() => {
        if (history.length > 1) {
          history.goBack();
        } else {
          history.replace('/new-user/guide');
        }
      }}
      title={t('page.newUserImport.createWalletType.title')}
    >
      <div className="mt-24 flex flex-col items-center justify-center gap-16">
        {/* MPC Wallet option — wallet is already booted, go straight to pairing */}
        <Item
          bgColor="var(--r-neutral-card2, #F2F4F7)"
          px={16}
          py={20}
          onClick={() =>
            history.push('/mpc-pairing', { successRoute: '/new-user/success' })
          }
          className="pl-[18px] rounded-[8px] text-[20px] leading-[24px] py-[21px] font-medium text-r-neutral-title1"
        >
          <div className="space-y-[8px]">
            <div className="flex items-center gap-[10px]">
              <RcAddAddressOptionMPCIcon className="w-[22px] h-[22px] shrink-0" />
              <span>{t('page.newUserImport.createWalletType.mpcWallet')}</span>
            </div>
            <div className="text-[13px] font-normal text-r-neutral-foot leading-snug">
              {t('page.newUserImport.createWalletType.mpcWalletDesc')}
            </div>
          </div>
        </Item>

        {/* Seed Phrase option — wallet is already booted, generate directly */}
        <Item
          bgColor="var(--r-neutral-card2, #F2F4F7)"
          px={16}
          py={20}
          onClick={() => history.push('/new-user/create-seed-phrase-booted')}
          className="pl-[18px] rounded-[8px] text-[20px] leading-[24px] py-[21px] font-medium text-r-neutral-title1"
        >
          <div className="space-y-[8px]">
            <div className="flex items-center gap-[10px]">
              <RcAddAddressOptionSeedPhraseIcon className="w-[22px] h-[22px] shrink-0" />
              <span>{t('page.newUserImport.createWalletType.seedPhraseWallet')}</span>
            </div>
            <div className="text-[13px] font-normal text-r-neutral-foot leading-snug">
              {t('page.newUserImport.createWalletType.seedPhraseWalletDesc')}
            </div>
          </div>
        </Item>
      </div>
    </Card>
  );
};
