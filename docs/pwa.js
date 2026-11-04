const $ = id => document.getElementById(id);

// Only the worker knows which version's complete resources are available.
// A marker alone cannot prove that browser-evicted assets are still present.
function send(worker, type, {timeout = 12000, onProgress} = {}) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('アプリの準備中です。少し待ってもう一度お試しください。'));
    const channel = new MessageChannel();
    const finish = (error, value) => {
      clearTimeout(timer);
      channel.port1.close();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('準備状態を確認できません。通信を確認するか、アプリを開き直してください。')), timeout);
    channel.port1.onmessage = ({data}) => {
      if (data.progress) onProgress?.(data.progress);
      if (data.error) return finish(new Error(data.error));
      if (data.done || typeof data.shellReady === 'boolean') finish(null, data);
    };
    try { worker.postMessage({type}, [channel.port2]); }
    catch (error) { finish(error); }
  });
}

export async function initPWA({isBusy = () => false} = {}) {
  let registration, promptEvent, installed = false, preparing = false;
  let readiness = null, wantsReload = false, lastUpdateCheck = 0;
  const standaloneQuery = matchMedia('(display-mode: standalone)');
  const standalone = () => navigator.standalone === true || standaloneQuery.matches;
  function installState() {
    const asApp = standalone();
    $('install-banner').hidden = asApp || installed;
    $('install-button').hidden = asApp || installed;
    $('pwa-mode').textContent = asApp ? '✓ ホーム画面のアプリとして起動中' : installed ? 'ホーム画面・アプリ一覧のアイコンから開いてください。' : 'ブラウザで利用中 · ホーム画面に追加できます';
    $('install-banner-button').textContent = promptEvent ? 'アプリを追加' : '追加方法';
  }
  async function install() {
    if (!promptEvent) return $('install-dialog').showModal();
    const event = promptEvent;
    promptEvent = null;
    try { await event.prompt(); if ((await event.userChoice).outcome === 'accepted') installed = true; }
    catch { $('install-dialog').showModal(); }
    installState();
  }
  $('install-button').onclick = $('install-banner-button').onclick = install;
  $('close-install').onclick = () => $('install-dialog').close();
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); promptEvent = event; installState(); });
  window.addEventListener('appinstalled', () => { installed = true; promptEvent = null; installState(); });
  standaloneQuery.addEventListener?.('change', installState);
  installState();

  function showNetwork() {
    $('offline-notice').hidden = navigator.onLine;
    $('offline-notice').textContent = readiness?.ocrReady
      ? 'オフラインです。写真読み取り・番号照合・梱包記録をこの端末で行えます。'
      : readiness?.shellReady
        ? 'オフラインです。手入力で番号照合・梱包記録ができます。写真読み取りは通信できる場所で準備してください。'
        : 'オフラインです。保存状態を確認しています。写真読み取りの初回準備には通信が必要です。';
  }
  function showReadiness(status) {
    readiness = status;
    $('prepare-offline').disabled = preparing || !status.shellReady;
    $('pwa-version').textContent = status.version ? `v${status.version}` : '';
    if (!preparing) {
      $('offline-status').textContent = status.ocrReady && status.shellReady
        ? '✓ 写真読み取り・番号照合・梱包記録のオフライン準備ができています。'
        : status.shellReady
          ? '✓ 画面を保存しました。手入力の照合・記録は通信なしで使えます。写真読み取りは下のボタンから準備します。'
          : '画面の保存を確認できません。通信できる場所で開き直してください。';
      $('prepare-offline').textContent = status.ocrReady ? '読み取りデータを準備し直す' : '写真読み取りの準備（約14MB）';
    }
    showNetwork();
  }
  const activeWorker = () => registration?.active || navigator.serviceWorker?.controller;
  async function refreshStatus() {
    try { showReadiness(await send(activeWorker(), 'GET_STATUS')); }
    catch (error) {
      readiness = null;
      $('prepare-offline').disabled = true;
      showNetwork();
      if (!preparing) $('offline-status').textContent = registration?.waiting
        ? '新しいバージョンに更新すると、オフラインの準備状態を確認できます。画面上の更新ボタンを押してください。'
        : error.message;
    }
  }
  function showUpdate() {
    const hasUpdate = Boolean(registration?.waiting && navigator.serviceWorker.controller);
    $('update-banner').hidden = !hasUpdate;
    if (hasUpdate) $('update-status').textContent = '新しいバージョンの準備ができました。作業の区切りで更新してください。';
  }
  function watchInstalling() {
    const worker = registration?.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') { showUpdate(); refreshStatus(); }
      if (worker.state === 'activated') { showUpdate(); refreshStatus(); }
      if (worker.state === 'redundant') $('update-status').textContent = '新しい画面を保存できませんでした。現在のバージョンで作業を続けられます。';
    });
  }
  async function checkUpdate(manual = false) {
    if (!registration || !navigator.onLine) {
      if (manual) $('update-status').textContent = '更新の確認にはインターネット接続が必要です。';
      return;
    }
    lastUpdateCheck = Date.now();
    if (manual) $('update-status').textContent = '更新を確認しています…';
    try {
      await registration.update();
      showUpdate();
      if (manual && !registration.waiting) $('update-status').textContent = registration.installing ? '新しいバージョンを準備しています…' : '現在のバージョンが最新です。';
      await refreshStatus();
    } catch {
      if (manual) $('update-status').textContent = '更新を確認できませんでした。通信を確認してください。現在の記録は保存されています。';
    }
  }
  $('check-update').onclick = () => checkUpdate(true);
  $('apply-update').onclick = async () => {
    if (!registration?.waiting) return showUpdate();
    if (isBusy() || preparing) {
      $('update-message').textContent = '読み取りや確認中の作業を完了するか、閉じてから更新してください。';
      return;
    }
    $('apply-update').disabled = true;
    $('update-message').textContent = '保存済みの記録を残して更新します…';
    wantsReload = true;
    try { await send(registration.waiting, 'SKIP_WAITING'); }
    catch (error) { wantsReload = false; $('update-message').textContent = error.message; $('apply-update').disabled = false; }
  };
  $('prepare-offline').onclick = async () => {
    if (preparing) return;
    preparing = true;
    $('prepare-offline').disabled = true;
    try {
      const status = await send(activeWorker(), 'PREPARE_OFFLINE', {
        timeout: 180000,
        onProgress: text => $('offline-status').textContent = text,
      });
      preparing = false;
      showReadiness(status);
    } catch (error) {
      preparing = false;
      await refreshStatus();
      $('offline-status').textContent = error.message + ' 手入力での記録は続けられます。';
    } finally { preparing = false; $('prepare-offline').disabled = !registration?.active || !readiness?.shellReady; }
  };
  window.addEventListener('online', () => { showNetwork(); refreshStatus(); });
  window.addEventListener('offline', () => { showNetwork(); refreshStatus(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && registration) {
      refreshStatus();
      if (Date.now() - lastUpdateCheck > 60000) checkUpdate();
    }
  });
  showNetwork();
  if (!('serviceWorker' in navigator)) {
    $('offline-status').textContent = 'このブラウザではオフライン準備ができません。iPhoneのSafariで開いてください。';
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    showUpdate();
    if (wantsReload) {
      wantsReload = false;
      if (!isBusy()) location.reload();
      else { $('apply-update').disabled = false; $('update-message').textContent = '更新できました。作業終了後にアプリを開き直してください。'; }
    } else refreshStatus();
  });
  try {
    registration = await navigator.serviceWorker.register('./sw.js', {scope: './', updateViaCache: 'none'});
    registration.addEventListener('updatefound', watchInstalling);
    watchInstalling();
    showUpdate();
    $('check-update').disabled = false;
    let readyTimer;
    const timeout = new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('画面の保存が完了していません。通信を確認して開き直してください。')), 30000); });
    await Promise.race([navigator.serviceWorker.ready, timeout]).finally(() => clearTimeout(readyTimer));
    await refreshStatus();
  } catch (error) { $('offline-status').textContent = error.message; }
}
