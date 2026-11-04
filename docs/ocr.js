import Tesseract from './vendor/tesseract.esm.min.js';

// All worker code and model data are bundled with this app. Images stay on-device.
const vendorURL = new URL('./vendor/', import.meta.url);
let workerPromise = null;
let progressListener = null;
let busy = false;

const progressLabels = {
  'loading tesseract core': '読み取りエンジンを準備しています',
  'initializing tesseract': '読み取りエンジンを準備しています',
  'loading language traineddata': '数字の読み取りデータを準備しています',
  'initializing api': '読み取りの準備をしています',
  'recognizing text': '番号を読み取っています',
};

function notify(message) {
  if (progressListener) progressListener({
    status: progressLabels[message.status] || '読み取りの準備をしています',
    progress: Math.max(0, Math.min(1, Number(message.progress) || 0)),
  });
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: new URL('worker.min.js', vendorURL).href,
      corePath: new URL('core/', vendorURL).href,
      langPath: new URL('lang/', vendorURL).href,
      gzip: true,
      cacheMethod: 'none',
      workerBlobURL: false,
      logger: notify,
      errorHandler: () => {}, // The rejected request is handled by recognize().
    }, {
      load_system_dawg: '0',
      load_freq_dawg: '0',
      load_number_dawg: '0',
      load_punc_dawg: '0',
    }).then(async worker => {
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: '7',
        user_defined_dpi: '300',
      });
      return worker;
    }).catch(error => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function prepare(source, contrast = false) {
  const width = source.width;
  const height = source.height;
  if (!width || !height) throw new Error('写真を読み込めませんでした。もう一度撮影してください。');
  // A label should fill the guide. Bound working memory on mobile devices.
  const scale = Math.min(1600 / width, 900 / height, Math.max(1, 1100 / width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)) + 48;
  canvas.height = Math.max(1, Math.round(height * scale)) + 48;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 24, 24, canvas.width - 48, canvas.height - 48);
  if (contrast) {
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < pixels.data.length; i += 4) {
      histogram[Math.round(0.299 * pixels.data[i] + 0.587 * pixels.data[i + 1] + 0.114 * pixels.data[i + 2])]++;
    }
    const percentile = fraction => {
      const target = canvas.width * canvas.height * fraction;
      let count = 0;
      for (let i = 0; i < 256; i++) { count += histogram[i]; if (count >= target) return i; }
      return 255;
    };
    const low = percentile(.01), high = percentile(.95);
    const threshold = low + (high - low) * .45;
    for (let i = 0; i < pixels.data.length; i += 4) {
      const gray = 0.299 * pixels.data[i] + 0.587 * pixels.data[i + 1] + 0.114 * pixels.data[i + 2];
      const level = gray < threshold ? 0 : 255;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = level;
    }
    ctx.putImageData(pixels, 0, 0);
  }
  return canvas;
}

export function candidatesFromText(text, confidence = 0) {
  const ids = new Set();
  for (const raw of String(text || '').split(/[\r\n]+/)) {
    const line = raw.normalize('NFKC').trim();
    // Never turn letters into digits or take eight digits out of a longer ID.
    if (/^[\d\t ]+$/.test(line) && /^\d{8}$/.test(line.replace(/[\t ]/g, ''))) {
      ids.add(line.replace(/[\t ]/g, ''));
    } else {
      for (const match of line.matchAll(/(^|[^\dA-Za-z])(\d{8})(?=$|[^\dA-Za-z])/g)) ids.add(match[2]);
    }
  }
  return [...ids].map(id => ({ id, confidence: Math.max(0, Math.min(100, Number(confidence) || 0)) }));
}

/** Read one horizontal label. OCR is a suggestion; the user must confirm its digits. */
export async function recognize(canvas, { onProgress } = {}) {
  if (busy) throw new Error('読み取り中です。完了するまでお待ちください。');
  busy = true;
  progressListener = onProgress;
  try {
    notify({ status: 'initializing api', progress: 0 });
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    let result = await worker.recognize(prepare(canvas), {}, { text: true });
    let candidates = candidatesFromText(result.data.text, result.data.confidence);
    // A second pass helps low-contrast labels, without changing the number itself.
    if (!candidates.length) {
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      result = await worker.recognize(prepare(canvas, true), {}, { text: true });
      candidates = candidatesFromText(result.data.text, result.data.confidence);
    }
    return { candidates, text: result.data.text || '' };
  } catch (error) {
    if (error?.message?.includes('写真を読み込めません')) throw error;
    throw new Error('番号を読み取れませんでした。シールを横向きで大きく写して再撮影するか、番号を入力してください。', { cause: error });
  } finally {
    progressListener = null;
    busy = false;
  }
}

export async function dispose() {
  if (busy) return;
  const promise = workerPromise;
  workerPromise = null;
  if (promise) {
    try { await (await promise).terminate(); } catch { /* Initialization already failed. */ }
  }
}
