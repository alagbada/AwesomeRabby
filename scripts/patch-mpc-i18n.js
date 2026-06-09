/**
 * Patches MPC-related i18n keys into all non-English locale files.
 *
 * New keys needed in every locale:
 *   addressDetail.exportMPCKeyShare
 *   addressDetail.exportMPCModal  (object)
 *   newUserImport.importWalletType.mpcWalletDesc
 *   newUserImport.importMPCRestore  (object)
 *
 * zh-CN and zh-HK get proper translations; all others get English fallback.
 */

const fs   = require('fs');
const path = require('path');

// ── translations ────────────────────────────────────────────────────────────

const patches = {
  // Simplified Chinese
  'zh-CN': {
    addressDetail_exportMPCKeyShare: '导出密钥份额备份',
    addressDetail_exportMPCModal: {
      title: '设置备份口令',
      desc: '此口令用于加密您的密钥份额文件。请将其与文件分开保存——两者同时拥有即可恢复您的钱包。',
      passphraseLabel: '备份口令',
      passphrasePlaceholder: '请输入强口令',
      confirmLabel: '确认口令',
      confirmPlaceholder: '再次输入口令',
      download: '下载备份',
      passphraseRequired: '请输入口令',
      passphraseMismatch: '两次口令不一致',
      success: '备份文件已下载',
    },
    importWalletType_mpcWalletDesc: '从 .json 备份文件恢复',
    importMPCRestore: {
      title: '恢复 MPC 钱包',
      subtitle: '上传您从之前 PrismTx 安装中导出的备份文件。',
      fileLabel: '备份文件（.json）',
      filePlaceholder: '点击选择备份文件…',
      browse: '浏览',
      passphraseLabel: '备份口令',
      passphrasePlaceholder: '导出时设置的口令',
      passwordLabel: '设置钱包密码',
      passwordPlaceholder: '至少 8 个字符',
      passwordConfirmPlaceholder: '确认钱包密码',
      restoreButton: '恢复钱包',
      errorNoFile: '请选择备份文件',
      errorNoPassphrase: '请输入备份口令',
      errorNoPassword: '请设置钱包密码',
      errorPasswordMismatch: '两次密码不一致',
      errorPasswordTooShort: '密码至少 8 个字符',
      errorGeneric: '恢复失败——请检查您的文件和口令',
    },
  },

  // Traditional Chinese
  'zh-HK': {
    addressDetail_exportMPCKeyShare: '匯出金鑰份額備份',
    addressDetail_exportMPCModal: {
      title: '設定備份密碼短語',
      desc: '此密碼短語用於加密您的金鑰份額檔案。請將其與檔案分開保存——兩者同時擁有即可恢復您的錢包。',
      passphraseLabel: '備份密碼短語',
      passphrasePlaceholder: '請輸入強密碼短語',
      confirmLabel: '確認密碼短語',
      confirmPlaceholder: '再次輸入密碼短語',
      download: '下載備份',
      passphraseRequired: '請輸入密碼短語',
      passphraseMismatch: '兩次密碼短語不一致',
      success: '備份檔案已下載',
    },
    importWalletType_mpcWalletDesc: '從 .json 備份檔案恢復',
    importMPCRestore: {
      title: '恢復 MPC 錢包',
      subtitle: '上傳您從之前 PrismTx 安裝中匯出的備份檔案。',
      fileLabel: '備份檔案（.json）',
      filePlaceholder: '點擊選擇備份檔案…',
      browse: '瀏覽',
      passphraseLabel: '備份密碼短語',
      passphrasePlaceholder: '匯出時設定的密碼短語',
      passwordLabel: '設定錢包密碼',
      passwordPlaceholder: '至少 8 個字元',
      passwordConfirmPlaceholder: '確認錢包密碼',
      restoreButton: '恢復錢包',
      errorNoFile: '請選擇備份檔案',
      errorNoPassphrase: '請輸入備份密碼短語',
      errorNoPassword: '請設定錢包密碼',
      errorPasswordMismatch: '兩次密碼不一致',
      errorPasswordTooShort: '密碼至少 8 個字元',
      errorGeneric: '恢復失敗——請檢查您的檔案和密碼短語',
    },
  },
};

// English fallback for all remaining locales
const enFallback = {
  addressDetail_exportMPCKeyShare: 'Export Key Share Backup',
  addressDetail_exportMPCModal: {
    title: 'Set Backup Passphrase',
    desc: 'This passphrase encrypts your key share file. Store it separately from the file — anyone with both can restore your wallet.',
    passphraseLabel: 'Backup passphrase',
    passphrasePlaceholder: 'Enter a strong passphrase',
    confirmLabel: 'Confirm passphrase',
    confirmPlaceholder: 'Re-enter passphrase',
    download: 'Download Backup',
    passphraseRequired: 'Please enter a passphrase',
    passphraseMismatch: 'Passphrases do not match',
    success: 'Backup file downloaded',
  },
  importWalletType_mpcWalletDesc: 'Restore from a .json backup file',
  importMPCRestore: {
    title: 'Restore MPC Wallet',
    subtitle: 'Upload the backup file you exported from a previous PrismTx installation.',
    fileLabel: 'Backup file (.json)',
    filePlaceholder: 'Click to select backup file…',
    browse: 'Browse',
    passphraseLabel: 'Backup passphrase',
    passphrasePlaceholder: 'Passphrase set at export time',
    passwordLabel: 'Set wallet password',
    passwordPlaceholder: 'At least 8 characters',
    passwordConfirmPlaceholder: 'Confirm wallet password',
    restoreButton: 'Restore Wallet',
    errorNoFile: 'Please select a backup file',
    errorNoPassphrase: 'Please enter the backup passphrase',
    errorNoPassword: 'Please set a wallet password',
    errorPasswordMismatch: 'Passwords do not match',
    errorPasswordTooShort: 'Password must be at least 8 characters',
    errorGeneric: 'Failed to restore wallet — check your file and passphrase',
  },
};

// All non-English locales
const locales = ['zh-CN', 'zh-HK', 'de', 'es', 'fr-FR', 'id', 'ja', 'ko', 'pt', 'pt-BR', 'ru', 'tr', 'ua-UA', 'vi'];

const localesDir = path.join(__dirname, '..', '_raw', 'locales');

// ── helper: set a deep path safely ─────────────────────────────────────────
function setDeep(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

// ── patch each locale ───────────────────────────────────────────────────────
let patchedCount = 0;

for (const locale of locales) {
  const filePath = path.join(localesDir, locale, 'messages.json');
  if (!fs.existsSync(filePath)) {
    console.warn(`SKIP (not found): ${filePath}`);
    continue;
  }

  const raw  = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  const p    = patches[locale] || enFallback;

  let changed = false;

  // 1. addressDetail.exportMPCKeyShare
  const ad = data?.page?.addressDetail;
  if (ad && !ad.exportMPCKeyShare) {
    ad.exportMPCKeyShare = p.addressDetail_exportMPCKeyShare;
    changed = true;
  }

  // 2. addressDetail.exportMPCModal
  if (ad && !ad.exportMPCModal) {
    ad.exportMPCModal = p.addressDetail_exportMPCModal;
    changed = true;
  }

  // 3. newUserImport.importWalletType.mpcWalletDesc
  const iwt = data?.page?.newUserImport?.importWalletType;
  if (iwt && !iwt.mpcWalletDesc) {
    iwt.mpcWalletDesc = p.importWalletType_mpcWalletDesc;
    changed = true;
  }

  // 4. newUserImport.importMPCRestore
  const nui = data?.page?.newUserImport;
  if (nui && !nui.importMPCRestore) {
    nui.importMPCRestore = p.importMPCRestore;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`PATCHED: ${locale}`);
    patchedCount++;
  } else {
    console.log(`OK (no changes needed): ${locale}`);
  }
}

console.log(`\nDone. ${patchedCount} file(s) patched.`);
