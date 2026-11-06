import Tesseract from './vendor/tesseract.esm.min.js';

// All worker code and model data are bundled with this app. Images stay on-device.
const vendorURL = new URL('./vendor/', import.meta.url);
let workerPromise = null;
let progressListener = null;
let busy = false;
const LIVE_SAMPLE_WIDTH = 800;
const LIVE_VERIFY_WIDTH = 1100;

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
      try {
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: '7',
          user_defined_dpi: '300',
        });
        return worker;
      } catch (error) {
        try { await worker.terminate(); } catch { /* Preserve the initialization error. */ }
        throw error;
      }
    }).catch(error => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function prepare(source, contrast = false, liveWidth = null) {
  const width = source.width;
  const height = source.height;
  if (!width || !height) throw new Error('写真を読み込めませんでした。もう一度撮影してください。');
  // A label should fill the guide. Bound working memory on mobile devices.
  const scale = liveWidth === null
    ? Math.min(1600 / width, 900 / height, Math.max(1, 1100 / width))
    : Math.min(liveWidth / width, 900 / height);
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
      // Keep soft digit edges for live scanning; photo fallback retains binarization.
      const level = contrast === 'stretch'
        ? high > low ? Math.max(0, Math.min(255, Math.round((gray - low) * 255 / (high - low)))) : Math.round(gray)
        : gray < threshold ? 0 : 255;
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

async function runOCR(onProgress, snapshot, read, errorMessage) {
  if (busy) throw new Error('読み取り中です。完了するまでお待ちください。');
  busy = true;
  progressListener = onProgress;
  let worker;
  try {
    // Capture inputs before awaiting initialization or another asynchronous operation.
    const input = snapshot();
    notify({ status: 'initializing api', progress: 0 });
    worker = await getWorker();
    return await read(worker, input);
  } catch (error) {
    if (worker) {
      workerPromise = null;
      try { await worker.terminate(); } catch { /* A fresh worker will be created on retry. */ }
    }
    if (error?.message?.includes('写真を読み込めません')) throw error;
    throw new Error(errorMessage, { cause: error });
  } finally {
    progressListener = null;
    busy = false;
  }
}

function liveReading(result) {
  const text = typeof result?.data?.text === 'string' ? result.data.text : '';
  const confidence = result?.data?.confidence;
  const candidates = candidatesFromText(text, Number.isFinite(confidence) && confidence >= 0 && confidence <= 100 ? confidence : 0);
  if (candidates.length > 1) return { candidates: [], text, reason: 'ambiguous' };
  if (candidates.length !== 1) return { candidates: [], text, reason: 'empty' };
  if (candidates[0].confidence < 70) return { candidates: [], text, reason: 'low-confidence' };
  return { candidates, text, reason: 'agree' };
}

const liveErrorMessage = '番号を読み取れませんでした。シールを横向きで大きく映して、もう一度お試しください。';

/** Read one horizontal label. OCR is a suggestion; the user must confirm its digits. */
export async function recognize(canvas, { onProgress } = {}) {
  return runOCR(onProgress, () => canvas, async worker => {
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
  }, '番号を読み取れませんでした。シールを横向きで大きく写して再撮影するか、番号を入力してください。');
}

/** One normal reading of a fresh camera frame. Cross-frame agreement is checked by the caller. */
export async function recognizeLiveSample(canvas, { onProgress } = {}) {
  return runOCR(onProgress, () => prepare(canvas, false, LIVE_SAMPLE_WIDTH), async (worker, prepared) => {
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    return liveReading(await worker.recognize(prepared, {}, { text: true }));
  }, liveErrorMessage);
}

/** Verify the saved frame with a different treatment; never substitute a similar number. */
export async function verifyLiveSample(canvas, expectedId, { onProgress } = {}) {
  if (typeof expectedId !== 'string' || !/^\d{8}$/.test(expectedId)) return { candidates: [], text: '', reason: 'unstable' };
  return runOCR(onProgress, () => prepare(canvas, 'stretch', LIVE_VERIFY_WIDTH), async (worker, prepared) => {
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    const result = liveReading(await worker.recognize(prepared, {}, { text: true }));
    if (result.candidates.length === 1 && result.candidates[0].id !== expectedId) return { candidates: [], text: result.text, reason: 'unstable' };
    return result;
  }, liveErrorMessage);
}

/** Two differently processed readings must agree before a live frame is useful. */
export async function recognizeLiveFrame(canvas, { onProgress } = {}) {
  return runOCR(onProgress, () => [prepare(canvas), prepare(canvas, 'stretch')], async (worker, [normal, contrast]) => {
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    const first = await worker.recognize(normal, {}, { text: true });
    const second = await worker.recognize(contrast, {}, { text: true });
    const readings = [first, second].map(result => {
      const confidence = result.data.confidence;
      return candidatesFromText(result.data.text, Number.isFinite(confidence) && confidence >= 0 && confidence <= 100 ? confidence : 0);
    });
    const text = first.data.text || '';
    if (readings.some(candidates => candidates.length > 1)) return { candidates: [], text, reason: 'ambiguous' };
    if (readings.some(candidates => candidates.length !== 1)) return { candidates: [], text, reason: 'empty' };
    const [a, b] = readings.map(candidates => candidates[0]);
    if (a.id !== b.id) return { candidates: [], text, reason: 'unstable' };
    if (a.confidence < 70 || b.confidence < 70) return { candidates: [], text, reason: 'low-confidence' };
    return { candidates: [{ id: a.id, confidence: Math.min(a.confidence, b.confidence) }], text, reason: 'agree' };
  }, liveErrorMessage);
}

export async function dispose() {
  if (busy) return;
  const promise = workerPromise;
  workerPromise = null;
  if (promise) {
    try { await (await promise).terminate(); } catch { /* Initialization already failed. */ }
  }
}
